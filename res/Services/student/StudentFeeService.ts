import crypto from "crypto";
import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";
import flutterwave from "../FlutterwaveService";

// Flutterwave v3 throws a misleading "decrypt" error on non-ASCII characters
// (em-dashes, accented letters) in request fields — strip them before sending.
const toAscii = (str: string) => String(str).replace(/[^\x20-\x7E]/g, "").trim();

/**
 * Self-service fee viewing/payment for a logged-in student — the student
 * equivalent of ParentService's getChildFees/initiateFeePayment. No
 * ownership check is needed the way the parent flow needs assertOwnsChild:
 * studentId here comes straight off the student's own verified JWT.
 */
export class StudentFeeService {
    async getFees(studentId: number) {
        const fees = await prisma.studentFee.findMany({
            where: { studentId },
            include: {
                feeStructure: { select: { term: true, session: true, items: { select: { name: true, amount: true } } } },
                payments: { orderBy: { paymentDate: "desc" } },
            },
            orderBy: { createdAt: "desc" },
        });

        return fees.map((f) => ({
            id: f.id,
            term: f.feeStructure.term,
            session: f.feeStructure.session,
            items: f.feeStructure.items,
            totalFee: f.totalFee,
            amountPaid: f.amountPaid,
            outstanding: f.totalFee - f.amountPaid,
            status: f.status,
            lastPaymentDate: f.payments[0]?.paymentDate ?? null,
            payments: f.payments.map((p) => ({
                id: p.id,
                amount: p.amount,
                paymentMethod: p.paymentMethod,
                paymentDate: p.paymentDate,
                receiptNo: p.receiptNo,
            })),
        }));
    }

    /**
     * Starts a Flutterwave bank-transfer charge for the student's own
     * outstanding fee. Mirrors ParentService.initiateFeePayment exactly —
     * same pending -> webhook-confirmed pattern, same Payment row shape —
     * just scoped to the student themselves instead of a parent+child pair.
     */
    async initiateFeePayment(studentId: number, studentFeeId: number) {
        const studentFee = await prisma.studentFee.findFirst({ where: { id: studentFeeId, studentId } });
        if (!studentFee) throw new AppError("Fee record not found", 404);

        const outstanding = studentFee.totalFee - studentFee.amountPaid;
        if (outstanding <= 0) throw new AppError("This fee is already fully paid", 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError("Student not found", 404);

        // Many students have no email of their own on file (bulk imports
        // often only capture the guardian's) — fall back to that rather
        // than blocking payment outright.
        const email = student.email || student.guardianEmail;
        if (!email) {
            throw new AppError(
                "No email on file for you to receive payment details — ask your school to add one before paying online",
                400
            );
        }

        const reference = `fee-${studentFeeId}-${crypto.randomUUID().slice(0, 8)}`;

        const charge = await flutterwave.createBankTransferCharge({
            amount: outstanding,
            email,
            fullname: toAscii(`${student.name} ${student.surname}`),
            phoneNumber: student.guardianNumber || undefined,
            reference,
            narration: toAscii(`Qalox school fee payment (${studentFee.id})`),
        });

        await prisma.payment.create({
            data: {
                studentFeeId,
                amount: outstanding,
                paymentMethod: "Flutterwave",
                receiptNo: reference,
                flwReference: reference,
                status: "pending",
            },
        });

        return {
            reference,
            amount: outstanding,
            currency: "NGN",
            bankTransfer: charge.bankTransfer,
        };
    }
}
