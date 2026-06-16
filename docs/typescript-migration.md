# TypeScript & OOP Adoption Guide

## Background
This project was initially built using JavaScript and a functional programming style.
To improve maintainability, scalability, and type safety, TypeScript and
Object-Oriented Programming (OOP) were gradually introduced.

## Scope of TypeScript Usage
TypeScript is **not enforced globally** across the project.
It is introduced incrementally to avoid breaking existing functionality.

Currently, TypeScript is used in:
- New feature modules
- Business logic–heavy components
- Complex domains (e.g., grading & result computation)

## Folder Structure
/controllers
  ├── admin (JavaScript - legacy)
  ├── grading (TypeScript - OOP)

/services
  ├── grading (TypeScript)

## Architectural Pattern
New TypeScript modules follow a layered architecture:
- Controller → Handles HTTP concerns
- Service → Business logic
- Prisma → Data access

## Why OOP?
OOP was introduced to:
- Encapsulate business rules
- Improve testability
- Encourage reuse of logic (e.g., grading calculations)
- Reduce controller complexity

## Guidelines
- Existing JavaScript code should remain untouched unless necessary
- New complex features should prefer TypeScript
- Controllers should be thin
- Business logic must live in Services

## Migration Strategy
The project follows an incremental migration approach:
- No mass refactoring
- Coexistence of JS and TS
- Gradual adoption based on feature complexity
