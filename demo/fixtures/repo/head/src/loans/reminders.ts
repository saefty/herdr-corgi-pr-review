import { dueSoon, type Loan } from "./loan";
import { sendEmail } from "../notify/email";

export interface LoanStore {
  open(): Promise<Loan[]>;
  markReminded(id: string, at: Date): Promise<void>;
}

export async function sendDueReminders(store: LoanStore, now = new Date()): Promise<number> {
  const loans = await store.open();
  let sent = 0;
  for (const loan of loans) {
    if (!dueSoon(loan, now) || loan.remindedAt) continue;
    const due = loan.dueAt.toISOString().slice(0, 10);
    await sendEmail(loan.memberEmail, "Your book is due soon", `Please return it by ${due}.`);
    await store.markReminded(loan.id, now);
    sent++;
  }
  return sent;
}
