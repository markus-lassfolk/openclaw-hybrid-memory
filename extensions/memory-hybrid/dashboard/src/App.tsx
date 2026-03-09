import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppLayout } from "@/components/AppLayout";
import Dashboard from "./pages/Dashboard";
import MemoryGraph from "./pages/MemoryGraph";
import FactsExplorer from "./pages/FactsExplorer";
import IssueTracker from "./pages/IssueTracker";
import KnowledgeClusters from "./pages/KnowledgeClusters";
import CostUsage from "./pages/CostUsage";
import FeatureConfig from "./pages/FeatureConfig";
import WorkflowPatterns from "./pages/WorkflowPatterns";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter basename="/plugins/memory-dashboard">
        <AppLayout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/graph" element={<MemoryGraph />} />
            <Route path="/facts" element={<FactsExplorer />} />
            <Route path="/issues" element={<IssueTracker />} />
            <Route path="/clusters" element={<KnowledgeClusters />} />
            <Route path="/cost" element={<CostUsage />} />
            <Route path="/config" element={<FeatureConfig />} />
            <Route path="/workflows" element={<WorkflowPatterns />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
