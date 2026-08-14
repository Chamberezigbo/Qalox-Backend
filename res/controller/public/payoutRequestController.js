/**
 * Marketer payout requests.
 *
 * Marketers cannot move their own money. They raise a request; a Super Admin
 * approves it, and only then does the wallet change.
 *
 * Funds are NOT reserved when a request is raised — the balance is re-checked
 * at approval time, and a marketer may hold only one pending request at once.
 * That keeps the model simple without letting someone queue several requests
 * that together exceed their balance.
 */

const prisma = require("../../util/prisma");
const logger = require("../../config/logger");

/**
 * POST /api/public/marketers/me/payout-request
 * Marketer raises a withdrawal request. Bearer token required.
 */
exports.createPayoutRequest = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;

    if (!marketerId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const { amount, note } = req.body;

    if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a positive number",
        code: "INVALID_AMOUNT",
      });
    }

    const marketer = await prisma.admin.findFirst({
      where: { id: marketerId, role: "marketer" },
      select: {
        id: true,
        isSuspended: true,
        walletBalance: true,
        verificationStatus: true,
        bankName: true,
        bankAccountNumber: true,
        bankAccountName: true,
      },
    });

    if (!marketer) {
      return res.status(404).json({
        success: false,
        message: "Marketer not found",
        code: "MARKETER_NOT_FOUND",
      });
    }

    if (marketer.isSuspended) {
      return res.status(403).json({
        success: false,
        message: "Suspended accounts cannot request payouts",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    // Same gate as a direct payout — money only leaves to a verified identity.
    if (marketer.verificationStatus !== "approved") {
      return res.status(403).json({
        success: false,
        message: "Identity verification must be approved before requesting a payout",
        code: "VERIFICATION_REQUIRED",
        details: { verificationStatus: marketer.verificationStatus || "pending" },
      });
    }

    if (!marketer.bankAccountNumber || !marketer.bankName || !marketer.bankAccountName) {
      return res.status(400).json({
        success: false,
        message: "Add your bank account details before requesting a payout",
        code: "BANK_DETAILS_REQUIRED",
      });
    }

    if (amount > (marketer.walletBalance || 0)) {
      return res.status(400).json({
        success: false,
        message: "Requested amount exceeds your available balance",
        code: "INSUFFICIENT_BALANCE",
        details: { walletBalance: marketer.walletBalance || 0 },
      });
    }

    const pending = await prisma.payoutRequest.findFirst({
      where: { marketerId, status: "pending" },
      select: { id: true, amount: true, createdAt: true },
    });

    if (pending) {
      return res.status(409).json({
        success: false,
        message: "You already have a payout request awaiting review",
        code: "PAYOUT_REQUEST_PENDING",
        details: { requestId: pending.id, amount: pending.amount, createdAt: pending.createdAt },
      });
    }

    const created = await prisma.payoutRequest.create({
      data: {
        marketerId,
        amount,
        note: note || null,
        // Snapshot the destination so a later bank-details edit cannot redirect
        // a payout that a Super Admin has already reviewed.
        bankName: marketer.bankName,
        bankAccountNumber: marketer.bankAccountNumber,
        bankAccountName: marketer.bankAccountName,
      },
      select: { id: true, amount: true, status: true, note: true, createdAt: true },
    });

    logger.info(`[PAYOUT_REQUEST] Created`, { marketerId, amount, requestId: created.id });

    return res.status(201).json({
      success: true,
      message: "Payout request submitted",
      data: created,
    });
  } catch (err) {
    logger.error(`[PAYOUT_REQUEST] Create failed`, { marketerId: req.user?.id, error: err.message });
    next(err);
  }
};

/**
 * GET /api/public/marketers/me/payout-requests
 * Marketer lists their own requests. Bearer token required.
 */
exports.getMyPayoutRequests = async (req, res, next) => {
  try {
    const marketerId = req.user?.id || req.marketer?.id;

    if (!marketerId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const status = req.query.status;

    const where = { marketerId, ...(status ? { status } : {}) };

    const [requests, total] = await Promise.all([
      prisma.payoutRequest.findMany({
        where,
        select: {
          id: true,
          amount: true,
          status: true,
          note: true,
          rejectionReason: true,
          reviewedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payoutRequest.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Payout requests retrieved",
      data: requests,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/public/payout-requests
 * Super Admin lists every request across all marketers.
 */
exports.getAllPayoutRequests = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const status = req.query.status;

    const where = status ? { status } : {};

    const [requests, total] = await Promise.all([
      prisma.payoutRequest.findMany({
        where,
        include: {
          marketer: {
            select: { id: true, name: true, email: true, tier: true, walletBalance: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payoutRequest.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Payout requests retrieved",
      data: requests,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/public/payout-requests/:id
 * Super Admin approves or rejects. Approving is what actually moves the money.
 */
exports.reviewPayoutRequest = async (req, res, next) => {
  try {
    const requestId = parseInt(req.params.id, 10);
    const { status, rejectionReason } = req.body;
    const reviewerId = req.user?.id || null;

    if (isNaN(requestId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid request ID",
        code: "INVALID_REQUEST",
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be 'approved' or 'rejected'",
        code: "INVALID_STATUS",
      });
    }

    const request = await prisma.payoutRequest.findUnique({
      where: { id: requestId },
      include: { marketer: { select: { id: true, walletBalance: true, totalWithdrawn: true } } },
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Payout request not found",
        code: "REQUEST_NOT_FOUND",
      });
    }

    if (request.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: `This request has already been ${request.status}`,
        code: "REQUEST_ALREADY_REVIEWED",
        details: { status: request.status, reviewedAt: request.reviewedAt },
      });
    }

    if (status === "rejected") {
      const updated = await prisma.payoutRequest.update({
        where: { id: requestId },
        data: {
          status: "rejected",
          rejectionReason: rejectionReason || null,
          reviewedByAdminId: reviewerId,
          reviewedAt: new Date(),
        },
      });

      logger.info(`[PAYOUT_REQUEST] Rejected`, { requestId, by: reviewerId });

      return res.status(200).json({
        success: true,
        message: "Payout request rejected",
        data: updated,
      });
    }

    // Approval. Re-check the balance here — it may have moved since the request
    // was raised, because raising one does not reserve funds.
    const balance = request.marketer.walletBalance || 0;

    if (request.amount > balance) {
      return res.status(400).json({
        success: false,
        message: "Marketer balance no longer covers this request",
        code: "INSUFFICIENT_BALANCE",
        details: { requested: request.amount, walletBalance: balance },
      });
    }

    // One transaction, so the wallet debit, the ledger row and the status
    // change cannot land partially.
    const result = await prisma.$transaction(async (tx) => {
      const newBalance = balance - request.amount;

      const marketer = await tx.admin.update({
        where: { id: request.marketerId },
        data: {
          walletBalance: newBalance,
          totalWithdrawn: (request.marketer.totalWithdrawn || 0) + request.amount,
          lastPayoutDate: new Date(),
        },
        select: { id: true, walletBalance: true, totalWithdrawn: true, lastPayoutDate: true },
      });

      await tx.walletTransaction.create({
        data: {
          marketerId: request.marketerId,
          type: "payout",
          amount: request.amount,
          description: request.note || `Payout request #${request.id}`,
          balanceAfter: newBalance,
        },
      });

      const updatedRequest = await tx.payoutRequest.update({
        where: { id: requestId },
        data: {
          status: "approved",
          reviewedByAdminId: reviewerId,
          reviewedAt: new Date(),
        },
      });

      return { request: updatedRequest, marketer };
    }, {
      // The database is reached over a remote proxy, so three round-trips can
      // exceed Prisma's 5s interactive-transaction default and abort a payout
      // that was otherwise valid. The work itself is tiny; the budget is for
      // network latency, not computation.
      timeout: 20000,
      maxWait: 10000,
    });

    logger.info(`[PAYOUT_REQUEST] Approved and paid`, {
      requestId,
      marketerId: request.marketerId,
      amount: request.amount,
      by: reviewerId,
    });

    return res.status(200).json({
      success: true,
      message: "Payout request approved",
      data: result,
    });
  } catch (err) {
    logger.error(`[PAYOUT_REQUEST] Review failed`, { requestId: req.params.id, error: err.message });
    next(err);
  }
};
