import { sendDueReminders } from "../src/loans/reminders";

const day = 24 * 60 * 60 * 1000;

test("reminds once, two days before the due date", async () => {
  const now = new Date("2026-03-10T08:00:00Z");
  const loan = { id: "l1", bookId: "b1", memberEmail: "noreply@example.com", borrowedAt: new Date(now.getTime() - 19 * day), dueAt: new Date(now.getTime() + day) };
  const marked: string[] = [];
  const store = { open: async () => [loan], markReminded: async (id: string) => void marked.push(id) };
  expect(await sendDueReminders(store, now)).toBe(1);
  expect(marked).toEqual(["l1"]);
});
