const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient();

const toDateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const isDecimal = (v) => Prisma?.Decimal && v instanceof Prisma.Decimal;

function transform(value) {
  if (value == null) return value;

  // Preserve primitives
  if (typeof value !== "object") return value;

  // Convert Decimal globally
  if (isDecimal(value)) return value.toNumber();

  // Preserve Date instances (handled key-aware below)
  if (value instanceof Date) return value;

  // Arrays
  if (Array.isArray(value)) return value.map(transform);

  // Plain object: transform entries
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "createdAt" && v instanceof Date) {
      out[k] = toDateOnly(v);
    } else if (isDecimal(v)) {
      out[k] = v.toNumber();
    } else {
      out[k] = transform(v);
    }
  }
  return out;
}

prisma.$use(async (params, next) => {
  const result = await next(params);
  return transform(result);
});

module.exports = prisma;
