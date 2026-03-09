import {
  Brain,
  LayoutDashboard,
  Network,
  Search,
  AlertTriangle,
  Boxes,
  DollarSign,
  Settings,
  Workflow,
} from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";

const items = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Memory Graph", url: "/graph", icon: Network },
  { title: "Facts Explorer", url: "/facts", icon: Search },
  { title: "Issue Tracker", url: "/issues", icon: AlertTriangle },
  { title: "Clusters", url: "/clusters", icon: Boxes },
  { title: "Cost & Usage", url: "/cost", icon: DollarSign },
  { title: "Configuration", url: "/config", icon: Settings },
  { title: "Workflows", url: "/workflows", icon: Workflow },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <Brain className="h-6 w-6 text-primary shrink-0" />
          {!collapsed && (
            <span className="text-sm font-bold tracking-tight text-foreground">
              Memory Dashboard
            </span>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const isActive =
                  item.url === "/"
                    ? location.pathname === "/"
                    : location.pathname.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <NavLink
                        to={item.url}
                        end={item.url === "/"}
                        className="transition-colors"
                        activeClassName="bg-primary/10 text-primary font-medium"
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span>{item.title}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
