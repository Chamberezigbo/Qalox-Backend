/**
 * End-to-end check of AI credit packs against a SCRATCH database: buying a pack,
 * the webhook granting it exactly once, no commission, the subscription left
 * alone, and purchased credits carrying over a term reset.
 *
 * Refuses to run unless DATABASE_URL is the scratch container on localhost:3307.
 *
 *   docker run -d --name qalox-scratch-mysql -e MYSQL_ROOT_PASSWORD=scratch \
 *     -e MYSQL_DATABASE=qalox_scratch -p 3307:3306 mysql:8.0
 *   export DATABASE_URL="mysql://root:scratch@127.0.0.1:3307/qalox_scratch"
 *   npx prisma db push --skip-generate
 *   node scripts/credit-packs-scratch-test.js
 */
require("ts-node/register/transpile-only");
const assert = require("assert");

if (!/@(127\.0\.0\.1|localhost):3307\//.test(process.env.DATABASE_URL || "")) {
  console.error("Refusing to run: DATABASE_URL must point at the scratch database on localhost:3307.");
  process.exit(1);
}

const prisma = require("../res/util/prisma");
const flutterwave = require("../res/Services/FlutterwaveService");
const billing = require("../res/Services/BillingService");
const { handleFlutterwaveWebhook } = require("../res/controller/webhookController");
const { AcademicTermService } = require("../res/Services/AcademicTermService");
const { getAiCreditsStatusForSchool } = require("../res/util/getAiCreditsAllowanceForSchool");
const AiCreditService = require("../res/Services/AiCreditService");

const log = (m) => console.log(`  ✓ ${m}`);

// Flutterwave is stubbed: nothing here may reach the real service.
flutterwave.createStandardCheckout = async () => ({ checkoutUrl: "https://checkout.example/pay" });
flutterwave.verifyWebhookSignature = () => true;
let verification = {};
flutterwave.verifyTransaction = async () => verification;

/** Delivers a webhook for a reference, as Flutterwave would. */
async function deliver(reference, { amount, currency = "NGN", status = "successful" } = {}) {
  verification = { status, tx_ref: reference, amount, currency };
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handleFlutterwaveWebhook(
    { headers: { "verif-hash": "ok" }, body: { event: "charge.completed", data: { status: "successful", tx_ref: reference, id: Date.now() } } },
    res,
    (e) => { throw e; }
  );
  return res;
}

async function seed() {
  const school = await prisma.school.create({ data: { name: `Packs ${Date.now()}`, prefix: "PCK", email: "school@x.com" } });
  const schoolId = school.id;
  await prisma.admin.create({ data: { name: "Head", email: `h${Date.now()}@x.com`, password: "x", role: "school_admin", schoolId } });
  const plan = await prisma.billingPlan.create({
    data: { name: `Plan ${Date.now()}`, monthlyPrice: 5000, annualPrice: 50000, features: "[]", aiCreditsPerTerm: 100 },
  });
  const sub = await prisma.schoolSubscription.create({
    data: { schoolId, billingPlanId: plan.id, billingCycle: "monthly", status: "active", nextBillingDate: new Date(Date.now() + 864e5 * 20) },
  });
  await prisma.school.update({ where: { id: schoolId }, data: { billingPlanId: plan.id } });
  const pack = await prisma.aiCreditPack.create({ data: { name: "Small", credits: 500, price: 2000 } });
  return { schoolId, plan, sub, pack };
}

async function main() {
  console.log("Seeding…");
  const w = await seed();
  const { schoolId } = w;

  console.log("Starting a purchase");
  const started = await billing.initializeCreditPackPayment({ schoolId, packId: w.pack.id });
  assert.ok(started.success, JSON.stringify(started));
  assert.strictEqual(started.data.credits, 500);
  const payment = await prisma.schoolPayment.findUnique({ where: { flwReference: started.data.reference } });
  assert.strictEqual(payment.purpose, "credit_pack");
  assert.strictEqual(payment.creditsGranted, 500);
  assert.strictEqual(payment.subscriptionId, null);
  const subAfter = await prisma.schoolSubscription.findUnique({ where: { id: w.sub.id } });
  assert.strictEqual(subAfter.status, "active", "starting a purchase must not lock the school");
  log("a pending pack payment is created and the subscription stays active");

  const inactive = await prisma.aiCreditPack.create({ data: { name: "Off", credits: 10, price: 100, isActive: false } });
  assert.strictEqual((await billing.initializeCreditPackPayment({ schoolId, packId: inactive.id })).code, "PACK_NOT_FOUND");
  log("an inactive pack cannot be bought");

  console.log("Webhook");
  // A pack edited after the purchase must not change what was paid for.
  await prisma.aiCreditPack.update({ where: { id: w.pack.id }, data: { credits: 50 } });

  // A marketer is attached to this school: they must earn nothing from a pack.
  const marketer = await prisma.admin.create({ data: { name: "M", email: `m${Date.now()}@x.com`, password: "x", role: "marketer", referralCode: `R${Date.now()}` } });
  await prisma.marketerSchoolLead.create({ data: { marketerId: marketer.id, schoolId, name: "S", email: "s@x.com" } });

  const wrongAmount = await deliver(started.data.reference, { amount: 1 });
  assert.match(wrongAmount.body.message, /not processed|Verification failed/i);
  const wrongCurrency = await deliver(started.data.reference, { amount: 2000, currency: "USD" });
  assert.match(wrongCurrency.body.message, /Currency mismatch/);
  const unknown = await deliver("qalox-nope", { amount: 2000 });
  assert.match(unknown.body.message, /No matching payment/);
  assert.strictEqual((await prisma.school.findUnique({ where: { id: schoolId } })).aiCreditsPurchased, 0);
  log("a wrong amount, a wrong currency and an unknown reference grant nothing");

  // The same delivery arriving three times at once.
  const results = await Promise.all([1, 2, 3].map(() => deliver(started.data.reference, { amount: 2000 })));
  assert.ok(results.every((r) => r.code === 200));
  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  assert.strictEqual(school.aiCreditsPurchased, 500, "granted exactly once, at the price paid for");
  assert.strictEqual((await prisma.schoolPayment.findUnique({ where: { flwReference: started.data.reference } })).status, "success");
  assert.strictEqual(await prisma.commission.count({ where: { schoolId } }), 0, "no commission on a pack");
  assert.strictEqual((await prisma.admin.findUnique({ where: { id: marketer.id } })).walletBalance, 0);
  assert.strictEqual((await prisma.schoolSubscription.findUnique({ where: { id: w.sub.id } })).status, "active");
  assert.ok(await prisma.userNotification.count({ where: { schoolId, title: "AI credits added" } }) >= 1);
  log("three simultaneous deliveries grant 500 credits once, with no commission and the plan untouched");

  console.log("Using the credits");
  let status = await getAiCreditsStatusForSchool(schoolId);
  assert.deepStrictEqual(
    { allowance: status.allowance, planAllowance: status.planAllowance, purchased: status.purchased, remaining: status.remaining },
    { allowance: 600, planAllowance: 100, purchased: 500, remaining: 600 }
  );
  await AiCreditService.reserveCredits(schoolId, 250);
  status = await getAiCreditsStatusForSchool(schoolId);
  assert.strictEqual(status.remaining, 350);
  log("the plan's 100 plus the 500 bought are spendable, and a 250 reservation leaves 350");

  console.log("Plan payment still behaves");
  const planPay = await prisma.schoolPayment.create({
    data: { schoolId, subscriptionId: w.sub.id, amount: 5000, flwReference: `qalox-${schoolId}-plan1`, status: "pending" },
  });
  await Promise.all([1, 2].map(() => deliver(planPay.flwReference, { amount: 5000 })));
  assert.strictEqual(await prisma.commission.count({ where: { schoolId } }), 1, "two deliveries pay commission once");
  const lead = await prisma.marketerSchoolLead.findUnique({ where: { schoolId } });
  assert.strictEqual(lead.totalCommission > 0, true);
  const paid = await prisma.schoolPayment.findUnique({ where: { id: planPay.id } });
  assert.strictEqual(paid.isFirstPayment, true, "the pack did not make this a renewal");
  log("a plan payment delivered twice pays commission once, and is still the school's first plan payment");

  console.log("Term reset");
  const session = await prisma.academicSession.create({ data: { schoolId, name: "2026/2027", isActive: true } });
  const term = await prisma.academicTerm.create({ data: { schoolId, sessionId: session.id, name: "Second Term" } });
  // 250 used: 100 from the plan, 150 from what was bought. 350 of the 500 remain.
  await new AcademicTermService().activateTerm({ termId: term.id, schoolId });
  const after = await prisma.school.findUnique({ where: { id: schoolId } });
  assert.strictEqual(after.aiCreditsUsedThisTerm, 0);
  assert.strictEqual(after.aiCreditsPurchased, 350);
  status = await getAiCreditsStatusForSchool(schoolId);
  assert.strictEqual(status.remaining, 450);
  log("the term reset renews the plan's 100 and keeps the 350 bought credits that were not spent");

  console.log("Taking credits back");
  const superBilling = require("../res/controller/superadmin/BillingController");
  const takeBack = async (credits) => {
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    await superBilling.deductSchoolCredits(
      { admin: { id: 1 }, params: { schoolId: String(schoolId) }, body: { credits, reason: "Granted by mistake" } },
      res,
      (e) => { throw e; }
    );
    return res;
  };
  // 350 bought. Three at once for 200 each: the row lock lets exactly one through.
  const attempts = await Promise.all([takeBack(200), takeBack(200), takeBack(200)]);
  const done = attempts.filter((r) => r.code === 201).length;
  assert.strictEqual(done, 1, `exactly one of three concurrent takes should win, got ${done}`);
  assert.strictEqual(attempts.filter((r) => r.code === 409).length, 2);
  const left = await prisma.school.findUnique({ where: { id: schoolId } });
  assert.strictEqual(left.aiCreditsPurchased, 150, "balance is 350 - 200, never negative");
  const adj = await prisma.schoolPayment.findMany({ where: { schoolId, purpose: "credit_adjustment" } });
  assert.strictEqual(adj.length, 1);
  assert.strictEqual(adj[0].creditsGranted, -200);
  log("three simultaneous take-backs: one wins, balance is 150, one adjustment recorded");

  // Spend most of it, then ask for more than is unspent.
  await prisma.school.update({ where: { id: schoolId }, data: { aiCreditsUsedThisTerm: 200 } }); // base 100 + 150 bought: 50 unspent
  const over = await takeBack(100);
  assert.strictEqual(over.code, 409);
  assert.strictEqual(over.body.data.available, 50);
  assert.strictEqual((await takeBack(50)).code, 201);
  assert.strictEqual((await prisma.school.findUnique({ where: { id: schoolId } })).aiCreditsPurchased, 100);
  log("cannot take back credits the school has already spent");

  console.log("\nAll checks passed.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("\n❌ FAILED:", error.message);
    if (error.stack) console.error(error.stack.split("\n").slice(1, 5).join("\n"));
    await prisma.$disconnect();
    process.exit(1);
  });
