// src/services/ParentService.ts
import crypto from "crypto";
import prisma from "../util/prisma";
import { AppError } from "../util/AppError";
import flutterwave from "./FlutterwaveService";

// Flutterwave v3 throws a misleading "decrypt" error on non-ASCII characters
// (em-dashes, accented letters) in request fields — strip them before sending.
const toAscii = (str: string) => String(str).replace(/[^\x20-\x7E]/g, "").trim();

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
     * Starts a Flutterwave bank-transfer charge for a student's outstanding
     * fee. Mirrors BillingController.initializePayment's shape (same pending
     * -> webhook-confirmed pattern) — the Payment row starts "pending" and is
     * only credited toward StudentFee.amountPaid once the webhook re-verifies
     * the transfer server-side.
     */
    async initiateFeePayment(parentId: number, studentId: number, studentFeeId: number) {
        await this.assertOwnsChild(parentId, studentId);

        const studentFee = await prisma.studentFee.findFirst({ where: { id: studentFeeId, studentId } });
        if (!studentFee) throw new AppError("Fee record not found", 404);

        const outstanding = studentFee.totalFee - studentFee.amountPaid;
        if (outstanding <= 0) throw new AppError("This fee is already fully paid", 400);

        const parent = await prisma.parent.findUnique({ where: { id: parentId } });
        if (!parent) throw new AppError("Parent not found", 404);

        const reference = `fee-${studentFeeId}-${crypto.randomUUID().slice(0, 8)}`;

        const charge = await flutterwave.createBankTransferCharge({
            amount: outstanding,
            email: parent.email,
            fullname: toAscii(parent.name),
            phoneNumber: parent.phone || undefined,
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
