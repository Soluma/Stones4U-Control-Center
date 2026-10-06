import { z } from "zod";

/** One limit for a task's description, shared by every create/edit API and the
 * form (CreateTaskDialog, TaskDetailView). Line breaks are kept as typed. */
export const TASK_DESCRIPTION_MAX = 5000;

export const taskDescriptionSchema = z.string().max(TASK_DESCRIPTION_MAX);
