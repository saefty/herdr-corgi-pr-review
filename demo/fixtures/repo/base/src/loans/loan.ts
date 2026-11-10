export interface Loan {
  id: string;
  bookId: string;
  memberEmail: string;
  borrowedAt: Date;
  returnedAt?: Date;
}

export function isOpen(loan: Loan): boolean {
  return loan.returnedAt === undefined;
}
