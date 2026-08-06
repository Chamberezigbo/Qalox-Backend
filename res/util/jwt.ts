import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET as string;

export interface TeacherJwtPayload {
    staffId: number;
    schoolId: number;
    campusId?: number;
    role: "teacher";
}

export interface StudentJwtPayload {
    studentId: number;
    schoolId: number;
    role: "student";
}

export interface ParentJwtPayload {
    parentId: number;
    role: "parent";
}


export const signStudentToken = (payload: StudentJwtPayload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "1d" });
};

export const signParentToken = (payload: ParentJwtPayload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
};


export const signTeacherToken = (payload: TeacherJwtPayload) => {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: "1d"
    });
};
