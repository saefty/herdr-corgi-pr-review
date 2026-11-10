export interface Loan {
  id: string;
  bookId: string;
  memberEmail: string;
  borrowedAt: Date;
  dueAt: Date;
  remindedAt?: Date;
  returnedAt?: Date;
}

export const LOAN_DAYS = 21;

export function isOpen(loan: Loan): boolean {
  return loan.returnedAt === undefined;
}

export function dueSoon(loan: Loan, now: Date, days = 2): boolean {
  const left = loan.dueAt.getTime() - now.getTime();
  return isOpen(loan) && left > 0 && left <= days * 24 * 60 * 60 * 1000;
}
