const express = require("express");
const Joi = require("joi");
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const authenticateSuperAdmin = require("../middleware/authenticateSuperAdmin");
const auth = require("../middleware/authLogin");

const router = express.Router();
const prisma = new PrismaClient();

// Environment variables for JWT
const JWT_SECRET = process.env.JWT_SECRET;