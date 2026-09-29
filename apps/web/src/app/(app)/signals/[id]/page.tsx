import { SignalDetail } from "@/components/signal-detail";

export default function SignalDetailPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  return <SignalDetail params={params} />;
}
