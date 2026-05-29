export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class DomainNotFoundError extends DomainError {
  constructor(entityName: string, id: string) {
    super(`${entityName} ${id} not found`);
    this.name = this.constructor.name;
  }
}

export class DomainConflictError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Authenticated but not permitted (e.g. a non-admin hitting an admin-only surface). Distinct from
// "not found" — the caller exists, the action is just gated. Maps to tRPC FORBIDDEN.
export class DomainForbiddenError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class DomainOperationError extends DomainError {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
