import prisma from "../../util/prisma";
import { AppError } from "../../util/AppError";
import { generateReceiptNo } from "../../util/receiptNo";
import { loadStudentFeeForReceipt, buildReceiptData } from "../../util/receiptData";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inAppFees = require("../InAppFeeService");

/**
 * Self-service fee viewing/payment for a logged-in student — the student
 * equivalent of ParentService's getChildFees/getBankAccounts/declarePayment.
 * No ownership check is needed the way the parent flow needs
 * assertOwnsChild: studentId here comes straight off the student's own
 * verified JWT.
 */
export class StudentFeeService {
    async getFees(studentId: number) {
        const fees = await prisma.studentFee.findMany({
            where: { studentId },
            include: {
                feeStructure: { select: { term: true, session: true, title: true, dueDate: true, items: { select: { name: true, amount: true } } } },
                payments: { orderBy: { paymentDate: "desc" } },
            },
            orderBy: { createdAt: "desc" },
        });

        return fees.map((f) => {
            // A pending or rejected declaration must never be reported as the
            // "last payment" — only a school-confirmed one actually happened.
            const latestConfirmed = f.payments.find((p) => p.status === "success");

            return {
                id: f.id,
                title: f.feeStructure.title,
                dueDate: f.feeStructure.dueDate,
                term: f.feeStructure.term,
                session: f.feeStructure.session,
                items: f.feeStructure.items,
                totalFee: f.totalFee,
                amountPaid: f.amountPaid,
                outstanding: f.totalFee - f.amountPaid,
                status: f.status,
                lastPaymentDate: latestConfirmed?.paymentDate ?? null,
                payments: f.payments.map((p) => ({
                    id: p.id,
                    amount: p.amount,
                    paymentMethod: p.paymentMethod,
                    paymentDate: p.paymentDate,
                    receiptNo: p.receiptNo,
                    status: p.status as "pending" | "success" | "failed",
                })),
            };
        });
    }

    /** Active bank accounts the student's school accepts fee payments into. */
    async getBankAccounts(studentId: number) {
        const student = await prisma.student.findUnique({ where: { id: studentId }, select: { schoolId: true } });
        if (!student) throw new AppError("Student not found", 404);

        return prisma.schoolBankAccount.findMany({
            where: { schoolId: student.schoolId, isActive: true },
            orderBy: { createdAt: "asc" },
        });
    }

    /**
     * Declares that a bank transfer has been made for this fee — replaces
     * the old Flutterwave-charge flow entirely. Creates a "pending" Payment
     * an admin must approve after checking their own bank statement; never
     * touches StudentFee.amountPaid itself, exactly like the old
     * Flutterwave-pending state never did until the webhook confirmed it.
     */
    async declarePayment(studentId: number, studentFeeId: number, bankAccountId: number, amount: number) {
        if (!amount || amount <= 0) throw new AppError("Enter a valid amount", 400);

        const student = await prisma.student.findUnique({ where: { id: studentId }, select: { schoolId: true } });
        if (!student) throw new AppError("Student not found", 404);
        // A school that collects fees through the app has no bank transfer to declare.
        if ((await inAppFees.getSettings(student.schoolId)).mode === "in_app") {
            throw new AppError("This school collects fees through the app. Use Pay now instead.", 409);
        }

        const studentFee = await prisma.studentFee.findFirst({ where: { id: studentFeeId, studentId } });
        if (!studentFee) throw new AppError("Fee record not found", 404);

        const bankAccount = await prisma.schoolBankAccount.findFirst({
            where: { id: bankAccountId, schoolId: student.schoolId, isActive: true },
        });
        if (!bankAccount) throw new AppError("Bank account not found", 404);

        const receiptNo = await generateReceiptNo();

        const payment = await prisma.payment.create({
            data: {
                studentFeeId,
                amount,
                paymentMethod: "Bank Transfer",
                receiptNo,
                bankAccountId,
                status: "pending",
            },
        });

        return {
            id: payment.id,
            receiptNo: payment.receiptNo,
            amount: payment.amount,
            status: payment.status,
            bankAccount: {
                bankName: bankAccount.bankName,
                accountName: bankAccount.accountName,
                accountNumber: bankAccount.accountNumber,
            },
        };
    }

    /** How this student's school collects fees (direct transfer, or pay in the app) and the service charge rate. */
    async getFeeCollection(studentId: number) {
        const student = await prisma.student.findUnique({ where: { id: studentId }, select: { schoolId: true } });
        if (!student) throw new AppError("Student not found", 404);
        const { mode, ready, serviceChargePercent } = await inAppFees.getCollection(student.schoolId);
        return { mode, ready, serviceChargePercent };
    }

    /** Starts an in-app payment for one of the student's own invoices; returns the hosted checkout. */
    async payOnline(studentId: number, studentFeeId: number, amount: number) {
        const student = await prisma.student.findUnique({ where: { id: studentId }, select: { schoolId: true, name: true, surname: true, email: true, guardianNumber: true } });
        if (!student) throw new AppError("Student not found", 404);
        return inAppFees.startPayment({
            schoolId: student.schoolId, studentFeeId, studentId, amount, area: "student",
            payer: { type: "student", id: studentId, name: `${student.name} ${student.surname}`, email: student.email, phone: student.guardianNumber },
        });
    }

    /** Where an online payment stands. Asks Flutterwave if the webhook has not told us yet. */
    async getFeePayment(studentId: number, reference: string) {
        const payment = await prisma.payment.findUnique({ where: { flwReference: reference }, include: { studentFee: { select: { studentId: true } } } });
        if (!payment || payment.channel !== "in_app" || payment.studentFee.studentId !== studentId) throw new AppError("Payment not found", 404);
        const outcome = await inAppFees.fulfil(reference);
        const p = outcome.payment ?? payment;
        return {
            status: outcome.status, amount: p.amount, serviceCharge: p.serviceCharge, chargedAmount: p.chargedAmount,
            receiptNo: p.receiptNo, studentFeeId: p.studentFeeId, studentId,
        };
    }

    /** Receipt for this student's own fee, once an admin has approved a payment against it. */
    async getReceipt(studentId: number, studentFeeId: number) {
        const studentFee = await loadStudentFeeForReceipt(studentFeeId);
        if (!studentFee || studentFee.studentId !== studentId) throw new AppError("Fee record not found", 404);

        if (studentFee.status === "unpaid" || studentFee.payments.length === 0) {
            throw new AppError("No payment recorded for this fee yet", 400);
        }

        return buildReceiptData(studentFee);
    }
}
