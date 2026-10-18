const prisma = require("./prisma");
const { schoolMediaUrl } = require("../controller/public/publicController");
const { resolveBranding } = require("./campusBranding");

/** Loads a StudentFee with everything a receipt needs — shared by admin, parent and student receipt endpoints. */
const loadStudentFeeForReceipt = (studentFeeId) =>
  prisma.studentFee.findUnique({
    where: { id: studentFeeId },
    include: {
      student: true,
      feeStructure: { include: { items: true, class: { select: { name: true, campusId: true } } } },
      payments: { orderBy: { paymentDate: "desc" }, take: 1 },
    },
  });

/** Assumes `studentFee` already has at least one payment loaded (caller has checked). */
const buildReceiptData = async (studentFee) => {
  const latestPayment = studentFee.payments[0];

  // The student's campus's own name, logo and stamp, else the school's.
  const school = await resolveBranding(prisma, {
    schoolId: studentFee.schoolId,
    campusId: studentFee.student?.campusId ?? studentFee.feeStructure?.class?.campusId ?? null,
  });
  const [schoolLogo, schoolStamp] = await Promise.all([
    schoolMediaUrl(school?.logoUrl),
    schoolMediaUrl(school?.stampUrl),
  ]);

  return {
    receiptNo: latestPayment.receiptNo,
    studentName: `${studentFee.student.name} ${studentFee.student.surname}`,
    admissionNo: studentFee.student.registrationNumber,
    class: studentFee.feeStructure.class.name,
    amountPaid: studentFee.amountPaid,
    paymentDate: latestPayment.paymentDate,
    paymentMethod: latestPayment.paymentMethod,
    items: studentFee.feeStructure.items.map((i) => ({ name: i.name, amount: i.amount })),
    term: studentFee.feeStructure.term,
    session: studentFee.feeStructure.session,
    isPartial: studentFee.status === "partial",
    outstanding: Math.max(studentFee.totalFee - studentFee.amountPaid, 0),
    parentEmail: studentFee.student.guardianEmail,
    parentPhone: studentFee.student.guardianNumber,
    schoolName: school?.name,
    logoUrl: schoolLogo,
    stampUrl: schoolStamp,
    brandColor: school?.brandColor,
  };
};

module.exports = { loadStudentFeeForReceipt, buildReceiptData };
