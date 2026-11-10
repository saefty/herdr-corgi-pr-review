import { mailer } from "./mailer";

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!/^[^@\s]+@[^@\s]+$/.test(to)) throw new Error(`invalid address: ${to}`);
  await mailer.send({ to, subject, text });
}
