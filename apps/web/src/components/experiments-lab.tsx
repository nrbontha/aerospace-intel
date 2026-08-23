"use client";

import { useState } from "react";

import { Tab, TabPanel, Tabs } from "@asi/ui";

import { QualifierLab } from "@/components/qualifier-lab";
import { ResearchLab } from "@/components/research-lab";

type LabTab = "qualifier" | "research";

export function ExperimentsLab() {
  const [activeTab, setActiveTab] = useState<LabTab>("qualifier");

  return (
    <section>
      <Tabs
        aria-label="Experiments labs"
        style={{ marginBlockEnd: "var(--asi-space-6)" }}
      >
        <Tab
          active={activeTab === "qualifier"}
          onClick={() => setActiveTab("qualifier")}
        >
          Qualifier Lab
        </Tab>
        <Tab
          active={activeTab === "research"}
          onClick={() => setActiveTab("research")}
        >
          Research Lab
        </Tab>
      </Tabs>

      <TabPanel active={activeTab === "qualifier"}>
        <QualifierLab />
      </TabPanel>
      <TabPanel active={activeTab === "research"}>
        <ResearchLab />
      </TabPanel>
    </section>
  );
}
