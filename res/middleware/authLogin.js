const jwt = require("jsonwebtoken");
const { AppError } = require("../util/AppError");

// Environment variables for JWT
const JWT_SECRET = process.env.JWT_SECRET;

const authenticate = (req, res, next) => {
       const token = req.headers.authorization?.split(" ")[1];
       if (!token) {
              next(new AppError("Access denied. No token provided.", 401));
       }

       try {
              const decoded = jwt.verify(token, JWT_SECRET);
              req.user = decoded;
              next();
       } catch (error) {
              next(new AppError("Access denied. Invalid token.", 401));
       }
}

module.exports = authenticate; 