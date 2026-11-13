const prisma = require("../../util/prisma");
const campusScope = require("../../util/campusScope");
const inAppFees = require("../../Services/InAppFeeService");
const { computeBreakdown } = require("../../util/feeCharge");

/**
 * How a school collects fees, and the online payments made through Qalox.
 *   GET /fees/collection         the current mode, whether it is ready, a worked example
 *   PUT /fees/collection         switch mode (head admin only)
 *   GET /fees/online-payments    online payments with totals
 */

const EXAMPLE_FEE = 50000;

const describe = async (schoolId) => {
  const collection = await inAppFees.getCollection(schoolId);
  return { ...collection, example: computeBreakdown(EXAMPLE_FEE, collection.serviceChargePercent) };
};

exports.getCollection = async (req, res, next) => {
  try {
    res.json({ success: true, data: await describe(req.schoolId) });
  } catch (error) {
    next(error);
  }
};

exports.setCollection = async (req, res, next) => {
  try {
    // How the whole school gets paid is the head admin's decision, not a campus sub-admin's.
    if (campusScope.isRestricted(req)) {
      return res.status(403).json({ success: false, message: "Only the head admin can change how fees are collected" });
    }
    const { mode, settlementBankAccountId } = req.body ?? {};
    await inAppFees.setCollection({ schoolId: req.schoolId, mode, settlementBankAccountId });
    res.json({ success: true, message: mode === "in_app" ? "In-app fee payment is on" : "Fees are paid directly to your account", data: await describe(req.schoolId) });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

exports.listOnlinePayments = async (req, res, next) => {
  try {
    const where = {
      channel: "in_app",
      studentFee: campusScope.withScope({ schoolId: req.schoolId }, campusScope.viaStudent(req)),
    };

    const [rows, groups] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { id: "desc" },
        take: 200,
        select: {
          id: true, amount: true, serviceCharge: true, chargedAmount: true, status: true, receiptNo: true, flwReference: true,
          paymentDate: true, createdAt: true, rejectionReason: true, payerType: true, studentFeeId: true,
          studentFee: { select: { student: { select: { name: true, surname: true, registrationNumber: true, class: { select: { name: true } } } }, feeStructure: { select: { term: true, session: true, title: true } } } },
        },
      }),
      prisma.payment.groupBy({ by: ["status"], where, _sum: { amount: true, serviceCharge: true, chargedAmount: true }, _count: { _all: true } }),
    ]);

    const of = (status) => groups.find((g) => g.status === status);
    res.json({
      success: true,
      data: {
        totals: {
          collected: of("success")?._sum.amount ?? 0,
          serviceCharges: of("success")?._sum.serviceCharge ?? 0,
          paidByParents: of("success")?._sum.chargedAmount ?? 0,
          successCount: of("success")?._count._all ?? 0,
          pendingCount: of("pending")?._count._all ?? 0,
          failedCount: of("failed")?._count._all ?? 0,
        },
        payments: rows.map((p) => ({
          id: p.id,
          studentName: `${p.studentFee.student.name} ${p.studentFee.student.surname}`,
          registrationNumber: p.studentFee.student.registrationNumber,
          className: p.studentFee.student.class?.name ?? "",
          feeTitle: p.studentFee.feeStructure.title,
          term: p.studentFee.feeStructure.term,
          session: p.studentFee.feeStructure.session,
          amount: p.amount,
          serviceCharge: p.serviceCharge,
          chargedAmount: p.chargedAmount,
          status: p.status,
          receiptNo: p.receiptNo,
          reference: p.flwReference,
          paidBy: p.payerType,
          date: p.paymentDate,
          createdAt: p.createdAt,
          note: p.rejectionReason,
          studentFeeId: p.studentFeeId,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

