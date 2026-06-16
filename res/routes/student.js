const express = require("express");
const Joi = require("joi");
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const auth = require("../middleware/authLogin");
const router = express.Router();
const prisma = new PrismaClient();

const { StudentAuthController } = require("../controller/auth/StudentAuthController");

const studentAuthController = new StudentAuthController();

// Public route — no auth needed to log in
router.post("/login", studentAuthController.login);


//Environment variables for Jwt
const JWT_SECRET = process.env.JWT_SECRET;

//validation Schema//
const studentSchema = Joi.object({
  school_id: Joi.number().required(),
  campus_id: Joi.number().required().optional(),
  class_id: Joi.number().required(),
  name: Joi.string().max(255).required(),
  email: Joi.string().email().required(),
  phoneNumber: Joi.string().max(50).optional(),
});

router.use(auth);

router.post("/create", async (req, res, next) => {
  const { error } = studentSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const { school_id, campus_id, name, email, phoneNumber, class_id } = req.body;

  try {
    const newStudent = await prisma.student.create({
      data: {
        school: {
          connect: { id: school_id }, // Link to existing school
        },
        campus: campus_id ? { connect: { id: campus_id } } : undefined, // Optional campus
        name,
        email,
        phoneNumber,
        class: {
          connect: { id: class_id },
        },
      },
    });
    res
      .status(201)
      .json({ message: "Student created successfully", newStudent });
  } catch (err) {
    next(err);
  }
});

// Route to get all students for a school//
router.get("/students", async (req, res, next) => {
  const schoolId = req.query.school_id || req.user.schoolId; // Use query param or user's schoolId
  if (!schoolId) {
    return res
      .status(400)
      .json({ message: "School ID is required to fetch classes." });
  }
  try {
    const students = await prisma.class.findMany({
      where: { schoolId: parseInt(schoolId) },
      include: {
        school: true,
        campus: true,
        teacher: true,
      },
    });

    if (!students.length) {
      return res
        .status(404)
        .json({ message: "No students found for the specified school." });
    }

    res
      .status(200)
      .json({ message: "Students fetched successfully", data: { students } });
  } catch (err) {
    next(err);
  }
});

/* ROUTE: Update a class (only school_admin and super_admin) */

module.exports = router;
