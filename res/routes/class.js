const express = require("express");
const Joi = require("joi");
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const auth = require("../middleware/authLogin");
const router = express.Router();
const prisma = new PrismaClient();

//Environment variables for JWT
const JWT_SECRET = process.env.JWT_SECRET;

// Validation Schema//

const classSchema = Joi.object({
  school_id: Joi.number().required(),
  campus_id: Joi.number().required(),
  name: Joi.string().max(255).required(),
  teacher_id: Joi.number().optional(),
});

const classGroupValidationSchema = Joi.object({
  campus_id: Joi.number().required().optional(),
  name: Joi.string().max(255).required(),
  teacher_id: Joi.number().optional(),
});

router.use(auth);

router.post("/create", async (req, res, next) => {
  const { error } = classSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const { school_id, campus_id, name, teacher_id } = req.body;

  try {
    const newClass = await prisma.class.create({
      data: {
        school: {
          connect: { id: school_id }, // Link to existing school
        },
        campus: campus_id ? { connect: { id: campus_id } } : undefined, // Optional campus
        name,
        teacher: teacher_id ? { connect: { id: teacher_id } } : undefined, // Optional teacher
      },
    });
    res.status(201).json({ message: "Class created successfully", newClass });
  } catch (err) {
    next(error);
  }
});

// ROUTE TO GET ALL CLASSES FOR A SCHOOL//
router.get("/classes", async (req, res, next) => {
  const schoolId = req.query.school_id || req.user.schoolId; // Use query param or user's schoolId
  if (!schoolId) {
    return res
      .status(400)
      .json({ message: "School ID is required to fetch classes." });
  }

  try {
    const classes = await prisma.class.findMany({
      where: { schoolId: parseInt(schoolId) },
      include: {
        school: true,
        campus: true,
        teacher: true,
      },
    });

    if (!classes.length) {
      return res
        .status(404)
        .json({ message: "No classes found for the specified school." });
    }

    res
      .status(200)
      .json({ message: "Classes fetched successfully", data: { classes } });
  } catch (error) {
    next(error);
  }
});

/* ROUTE: Update a class (only school_admin and super_admin) */
router.put("/:id", async (req, res, next) => {
  const { error } = classValidationSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const { id } = req.params;
  const { campus_id, name, teacher_id } = req.body;

  try {
    const updatedClass = await prisma.class.update({
      where: { id: parseInt(id) },
      data: { campus_id, name, teacher_id },
    });

    res
      .status(200)
      .json({ message: "Class updated successfully", class: updatedClass });
  } catch (err) {
    next(err);
  }
});

/* ROUTE: Delete a class (only super_admin) */
router.delete("/:id", async (req, res, next) => {
  const { id } = req.params;

  try {
    await prisma.class.delete({ where: { id: parseInt(id) } });
    res.status(200).json({ message: "Class deleted successfully" });
  } catch (err) {
    next(err);
  }
});

/* ROUTE: Add a group to a class (only school_admin and super_admin) */
router.post("/:id/groups", async (req, res, next) => {
  const { error } = classGroupValidationSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.details[0].message });
  }

  const { id } = req.params;
  const { name } = req.body;

  try {
    const newGroup = await prisma.class_group.create({
      data: {
        class_id: parseInt(id),
        name,
      },
    });

    res
      .status(201)
      .json({ message: "Class group created successfully", group: newGroup });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
