import { CandidateProfile } from "@/components/candidate-profile/candidate-profile";

export const metadata = {
  title: "Candidate profile",
};

type CandidatePageProps = { params: Promise<{ id: string }> };

export default async function CandidatePage({ params }: CandidatePageProps) {
  const { id } = await params;
  return <CandidateProfile candidateId={id} />;
}
