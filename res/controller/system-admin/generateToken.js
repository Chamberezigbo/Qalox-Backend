// controllers/tokenController.js
const prisma = require("../../util/prisma");
const crypto = require("crypto");

exports.generateToken = async (req, res, next) => {
  try {
    const { email, schoolName } = req.body;
    const existingToken = await prisma.token.findUnique({
      where: { email },
    });

    if (existingToken) {
      return res.status(409).json({
        message: "A token for this email has been taken",
        token: existingToken.uniqueKey,
      });
    }

    const uniqueKey = `Test-${crypto.randomBytes(16).toString("hex")}`;

    const newToken = await prisma.token.create({
      data: {
        email,
        schoolName,
        uniqueKey,
        status: "active",
      },
    });

    return res.status(201).json({
      message: "Token generated successfully",
      token: newToken.uniqueKey,
    });
  } catch (err) {
    next(err);
  }
};
