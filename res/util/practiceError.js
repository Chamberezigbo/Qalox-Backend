/** A problem the practice tools can explain to whoever called them (a status and a short code). */
class PracticeError extends Error {
  constructor(message, status = 400, code = "PRACTICE_ERROR") {
    super(message);
    this.name = "PracticeError";
    this.status = status;
    this.code = code;
  }
}

module.exports = { PracticeError };
