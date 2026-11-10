import { mailer } from "./mailer";

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  await mailer.send({ to, subject, text });
}
