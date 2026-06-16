// src/dtos/grading.dto.ts
export interface GradeInput {
    min: number
    max: number
    grade: string
    remark: string
}

export interface CreateGradingSchemeDTO {
    name: string
    usePosition: boolean
    campusId?: number
    classIds: number[]
    grades: GradeInput[]
}

export interface UpdateGradingSchemeDTO {
    name?: string
    usePosition?: boolean
    campusId?: number | null
    grades?: GradeInput[]
    classIds?: number[]
}
