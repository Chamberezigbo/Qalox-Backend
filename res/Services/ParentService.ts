// src/services/ParentService.ts
import prisma from "../util/prisma";
import { AppError } from "../util/AppError";
import { generateReceiptNo } from "../util/receiptNo";
import { loadStudentFeeForReceipt, buildReceiptData } from "../util/receiptData";

export class ParentService {
    /** Confirms the requesting parent actually owns this child before any read. */
    private async assertOwnsChild(parentId: number, studentId: number) {
        const student = await prisma.student.findFirst({ where: { id: studentId, parentId } });
        if (!student) throw new AppError("Child not found", 404);
        return student;
    }

    async getChildren(parentId: number) {
        const children = await prisma.student.findMany({
            where: { parentId },
            select: {
                id: true,
                name: true,
                surname: true,
                otherNames: true,
                registrationNumber: true,
                gender: true,
                passportUrl: true,
                class: { select: { id: true, name: true, customName: true } },
            },
            orderBy: { surname: "asc" },
        });

        return children.map((c) => ({
            id: c.id,
            name: c.name,
            surname: c.surname,
            otherNames: c.otherNames,
            registrationNumber: c.registrationNumber,
            gender: c.gender,
            passportUrl: c.passportUrl,
            className: c.class.customName ?? c.class.name,
        }));
    }

    async getChildResults(parentId: number, studentId: number) {
        await this.assertOwnsChild(parentId, studentId);

        const rows = await prisma.publishedResultRow.findMany({
            where: { studentId },
            include: {
                publishedResult: {
                    select: {
                        subject: { select: { name: true } },
                        academicSession: { select: { name: true } },
                        term: { select: { name: true } },
                        publishedAt: true,
                    },
                },
            },
            orderBy: { publishedResult: { publishedAt: "desc" } },
        });

        return rows.map((r) => ({
            subject: r.publishedResult.subject.name,
            session: r.publishedResult.academicSession.name,
            term: r.publishedResult.term?.name ?? null,
            caTotal: r.caTotal,
            examTotal: r.examTotal,
            total: r.total,
            grade: r.grade,
            remark: r.remark,
            position: r.position,
            publishedAt: r.publishedResult.publishedAt,
        }));
    }

    async getChildAttendance(parentId: number, studentId: number, startDate?: string, endDate?: string) {
        await this.assertOwnsChild(parentId, studentId);

        const end = endDate ? new Date(`${endDate}T23:59:59.999Z`) : new Date();
        const start = startDate ? new Date(`${startDate}T00:00:00.000Z`) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

        const records = await prisma.attendance.findMany({
            where: { studentId, date: { gte: start, lte: end } },
            orderBy: { date: "desc" },
            select: { date: true, status: true },
        });

        const present = records.filter((r) => r.status === "present").length;
        const absent = records.filter((r) => r.status === "absent").length;
        const late = records.filter((r) => r.status === "late").length;
        const total = records.length;

        return {
            records: records.map((r) => ({ date: r.date.toISOString().slice(0, 10), status: r.status })),
            summary: {
                present,
                absent,
                late,
                attendanceRate: total > 0 ? Math.round(((present + late) / total) * 100) : 0,
            },
        };
    }

    async getChildFees(parentId: number, studentId: number) {
        await this.assertOwnsChild(parentId, studentId);

        const fees = await prisma.studentFee.findMany({
            where: { studentId },
            include: {
                feeStructure: { select: { term: true, session: true, items: { select: { name: true, amount: true } } } },
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

    /** Active bank accounts the child's school accepts fee payments into. */
    async getBankAccounts(parentId: number, studentId: number) {
        const student = await this.assertOwnsChild(parentId, studentId);

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
    async declarePayment(parentId: number, studentId: number, studentFeeId: number, bankAccountId: number, amount: number) {
        const student = await this.assertOwnsChild(parentId, studentId);

        if (!amount || amount <= 0) throw new AppError("Enter a valid amount", 400);

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

    /** Receipt for a child's fee, once an admin has approved a payment against it. */
    async getReceipt(parentId: number, studentId: number, studentFeeId: number) {
        await this.assertOwnsChild(parentId, studentId);

        const studentFee = await loadStudentFeeForReceipt(studentFeeId);
        if (!studentFee || studentFee.studentId !== studentId) throw new AppError("Fee record not found", 404);

        if (studentFee.status === "unpaid" || studentFee.payments.length === 0) {
            throw new AppError("No payment recorded for this fee yet", 400);
        }

        return buildReceiptData(studentFee);
    }

    async getAlerts(parentId: number, limit = 20) {
        const alerts = await prisma.parentAlert.findMany({
            where: { parentId },
            include: { student: { select: { name: true, surname: true } } },
            orderBy: { createdAt: "desc" },
            take: limit,
        });

        return alerts.map((a) => ({
            id: a.id,
            studentId: a.studentId,
            studentName: `${a.student.name} ${a.student.surname}`,
            type: a.type,
            message: a.message,
            isRead: a.isRead,
            createdAt: a.createdAt,
        }));
    }

    async markAlertRead(parentId: number, alertId: number) {
        const alert = await prisma.parentAlert.findFirst({ where: { id: alertId, parentId } });
        if (!alert) throw new AppError("Alert not found", 404);

        await prisma.parentAlert.update({ where: { id: alertId }, data: { isRead: true } });
        return { id: alertId, isRead: true };
    }
}
