import { notFound } from "next/navigation";
import { getSessionUser } from "@/platform/auth/session";
import { getTaskDetail } from "@/modules/tasks/task.service";
import { TaskDetailView } from "./TaskDetailView";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  let task;
  try {
    task = await getTaskDetail(id);
  } catch {
    notFound();
  }

  const canEdit = user.role === "ADMIN" || user.id === task.assignedToId || user.id === task.createdById;
  const canWrite = user.role !== "VIEWER";

  return <TaskDetailView initialTask={JSON.parse(JSON.stringify(task))} canEdit={canEdit && canWrite} />;
}
