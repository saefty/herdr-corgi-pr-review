type Job = () => Promise<void>;

const jobs: Array<{ name: string; every: number; run: Job }> = [];

export function schedule(name: string, every: number, run: Job): void {
  jobs.push({ name, every, run });
}

export function start(): void {
  for (const job of jobs) setInterval(() => void job.run(), job.every);
}
