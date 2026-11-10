import { sendDueReminders } from "../loans/reminders";
import { loanStore } from "../loans/store";

type Job = () => Promise<void>;

const jobs: Array<{ name: string; every: number; run: Job }> = [];
const DAY = 24 * 60 * 60 * 1000;

export function schedule(name: string, every: number, run: Job): void {
  jobs.push({ name, every, run });
}

schedule("due-reminders", DAY, async () => {
  await sendDueReminders(loanStore);
});

export function start(): void {
  for (const job of jobs) setInterval(() => void job.run(), job.every);
}
