#!/usr/bin/env node

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

// Load .env file from the project root
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Request } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { LinearClient } from "@linear/sdk";

let workspacesConfig: {
  workspaces: Array<{
    id: string;
    name: string;
    email: string;
    apiKey: string;
    aliases?: string; // Comma-separated aliases
  }>;
  activeWorkspaceId?: string;
} | null = null;

try {
  const apiKeyValue = process.env.LINEAR_API_KEY || process.env.LINEARAPIKEY;
  if (apiKeyValue) {
    // Check if LINEAR_API_KEY is a JSON string
    try {
      // Attempt to decode the string in case it's URL encoded
      const decodedValue = decodeURIComponent(apiKeyValue);
      const maybeJson = JSON.parse(decodedValue);
      // If it's a JSON object with workspaces property, use it as workspacesConfig
      if (maybeJson && typeof maybeJson === 'object' && Array.isArray(maybeJson.workspaces)) {
        workspacesConfig = maybeJson;
        console.log("Using LINEAR_API_KEY as multi-workspace configuration");
      }
    } catch (jsonError) {
      // Not JSON or not decodable, will use as simple API key
      console.log("Could not parse LINEAR_API_KEY as JSON, using as simple API key");
    }
  }
} catch (error) {
  console.error("Error parsing LINEAR_API_KEY:", error);
  console.error("Please check the JSON format of your LINEAR_API_KEY environment variable.");
  process.exit(1);
}

// Fall back to simple API_KEY if no JSON config
const API_KEY = process.env.LINEAR_API_KEY || process.env.LINEARAPIKEY;
if (!workspacesConfig && !API_KEY) {
  console.error("Error: LINEAR_API_KEY environment variable is required");
  console.error("");
  console.error("To use multiple workspaces, set the LINEAR_API_KEY environment variable with JSON format:");
  console.error("LINEAR_API_KEY='{");
  console.error("  \"workspaces\": [");
  console.error("    {");
  console.error("      \"id\": \"work-project\",");
  console.error("      \"name\": \"Work Project\",");
  console.error("      \"email\": \"work@example.com\",");
  console.error("      \"apiKey\": \"your_work_api_key_here\",");
  console.error("      \"aliases\": \"work, main\"");
  console.error("    },");
  console.error("    {");
  console.error("      \"id\": \"personal-project\",");
  console.error("      \"name\": \"Personal Project\",");
  console.error("      \"email\": \"personal@example.com\",");
  console.error("      \"apiKey\": \"your_personal_api_key_here\",");
  console.error("      \"aliases\": \"personal, side\"");
  console.error("    }");
  console.error("  ],");
  console.error("  \"activeWorkspaceId\": \"work-project\"");
  console.error("}'\n");
  console.error("");
  console.error("Or, to use a single workspace, set LINEAR_API_KEY:");
  console.error("LINEAR_API_KEY=your-api-key npx linear-mcp");
  console.error("");
  console.error("Or set it in your environment:");
  console.error("export LINEAR_API_KEY=your-api-key");
  console.error("npx linear-mcp");
  process.exit(1);
}

// Create a map of LinearClient instances by workspace ID
const linearClients = new Map<string, LinearClient>();

// Initialize clients for multi-workspace setup
if (workspacesConfig && workspacesConfig.workspaces && workspacesConfig.workspaces.length > 0) {
  for (const workspace of workspacesConfig.workspaces) {
    linearClients.set(workspace.id, new LinearClient({
      apiKey: workspace.apiKey,
    }));
  }
} else if (API_KEY) {
  // Fall back to single workspace if no JSON config is available
  const defaultWorkspaceId = "default";
  linearClients.set(defaultWorkspaceId, new LinearClient({
    apiKey: API_KEY,
  }));
  
  if (!workspacesConfig) {
    workspacesConfig = {
      workspaces: [
        {
          id: defaultWorkspaceId,
          name: "Default Workspace",
          email: "default@linear-mcp.local",
          apiKey: API_KEY
        }
      ],
      activeWorkspaceId: defaultWorkspaceId
    };
  }
}

// Function to get the active linear client
const getLinearClient = (workspaceId?: string): LinearClient => {
  // If workspace ID is provided, use that client
  if (workspaceId && linearClients.has(workspaceId)) {
    return linearClients.get(workspaceId)!;
  }
  
  // If no workspace ID provided, use the active workspace ID from config
  if (workspacesConfig?.activeWorkspaceId && linearClients.has(workspacesConfig.activeWorkspaceId)) {
    return linearClients.get(workspacesConfig.activeWorkspaceId)!;
  }
  
  // If no active workspace ID in config, use the first workspace
  if (workspacesConfig?.workspaces && workspacesConfig.workspaces.length > 0) {
    return linearClients.get(workspacesConfig.workspaces[0].id)!;
  }
  
  throw new Error("No Linear client available. Please check your configuration.");
};

// The default linearClient for backward compatibility
const linearClient = getLinearClient();

// Helper to find a workspace by name, ID, or alias
const findWorkspace = (nameOrIdOrAlias: string): { id: string; name: string; email: string; aliases?: string } | null => {
  if (!workspacesConfig || !workspacesConfig.workspaces) return null;
  
  const lowercaseSearch = nameOrIdOrAlias.toLowerCase();
  
  // First try to find by exact ID match
  const workspaceById = workspacesConfig.workspaces.find(ws => ws.id === nameOrIdOrAlias);
  if (workspaceById) {
    return workspaceById;
  }
  
  // Then try to find by name (case insensitive)
  const workspaceByName = workspacesConfig.workspaces.find(ws => 
    ws.name.toLowerCase() === lowercaseSearch
  );
  if (workspaceByName) {
    return workspaceByName;
  }
  
  // Finally, try to find by alias
  const workspaceByAlias = workspacesConfig.workspaces.find(ws => {
    if (!ws.aliases) return false;
    const aliases = ws.aliases.split(',').map(a => a.trim().toLowerCase());
    return aliases.includes(lowercaseSearch);
  });
  
  return workspaceByAlias || null;
};

const server = new Server(
  {
    name: "linear-mcp",
    version: "39.0.0", // Match Linear SDK version
  },
  {
    capabilities: {
      tools: {
        list_workspaces: true,
        create_issue: true,
        list_issues: true,
        update_issue: true,
        list_teams: true,
        list_projects: true,
        search_issues: true,
        get_issue: true,
        get_issue_status: true,
      },
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_workspaces",
      description: "List available workspaces to use for Linear operations",
      inputSchema: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description: "Workspace name, id, or alias to select",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          workspaces: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
              },
            },
          },
          activeWorkspace: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      },
    },
    {
      name: "create_issue",
      description: "Create a new issue in Linear",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Issue title",
          },
          description: {
            type: "string",
            description: "Issue description (markdown supported)",
          },
          teamId: {
            type: "string",
            description: "Team ID",
          },
          assigneeId: {
            type: "string",
            description: "Assignee user ID (optional)",
          },
          priority: {
            type: "number",
            description: "Priority (0-4, optional)",
            minimum: 0,
            maximum: 4,
          },
          labels: {
            type: "array",
            items: {
              type: "string",
            },
            description: "Label IDs to apply (optional)",
          },
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)",
          },
        },
        required: ["title", "teamId"],
      },
    },
    {
      name: "list_issues",
      description: "List issues with optional filters",
      inputSchema: {
        type: "object",
        properties: {
          teamId: {
            type: "string",
            description: "Filter by team ID (optional)",
          },
          assigneeId: {
            type: "string",
            description: "Filter by assignee ID (optional)",
          },
          status: {
            type: "string",
            description: "Filter by status (optional)",
          },
          first: {
            type: "number",
            description: "Number of issues to return (default: 50)",
          },
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)",
          },
        },
      },
    },
    {
      name: "update_issue",
      description: "Update an existing issue",
      inputSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue ID",
          },
          title: {
            type: "string",
            description: "New title (optional)",
          },
          description: {
            type: "string",
            description: "New description (optional)",
          },
          status: {
            type: "string",
            description: "New status (optional)",
          },
          assigneeId: {
            type: "string",
            description: "New assignee ID (optional)",
          },
          priority: {
            type: "number",
            description: "New priority (0-4, optional)",
            minimum: 0,
            maximum: 4,
          },
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)",
          },
        },
        required: ["issueId"],
      },
    },
    {
      name: "get_issue_status",
      description: "Get all workflow states (statuses) for a team, including id, name, description, position, and type.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: {
            type: "string",
            description: "The ID of the team to fetch statuses for."
          },
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)"
          }
        },
        required: ["teamId"]
      }
    },
    {
      name: "list_teams",
      description: "List all teams in the workspace",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)",
          },
        },
      },
    },
    {
      name: "list_projects",
      description: "List all projects",
      inputSchema: {
        type: "object",
        properties: {
          teamId: {
            type: "string",
            description: "Filter by team ID (optional)",
          },
          first: {
            type: "number",
            description: "Number of projects to return (default: 50)",
          },
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)",
          },
        },
      },
    },
    {
      name: "search_issues",
      description: "Search for issues using a text query",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query text",
          },
          first: {
            type: "number",
            description: "Number of results to return (default: 50)",
          },
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_issue",
      description: "Get detailed information about a specific issue",
      inputSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue ID",
          },
          workspaceId: {
            type: "string",
            description: "Workspace ID to use (optional)",
          },
        },
        required: ["issueId"],
      },
    },
  ],
}));

type CreateIssueArgs = {
  title: string;
  description?: string;
  teamId: string;
  assigneeId?: string;
  priority?: number;
  labels?: string[];
};

type ListIssuesArgs = {
  teamId?: string;
  assigneeId?: string;
  status?: string;
  first?: number;
};

type UpdateIssueArgs = {
  issueId: string;
  title?: string;
  description?: string;
  status?: string;
  assigneeId?: string;
  priority?: number;
};

type ListProjectsArgs = {
  teamId?: string;
  first?: number;
};

type SearchIssuesArgs = {
  query: string;
  first?: number;
};

type GetIssueArgs = {
  issueId: string;
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "list_workspaces": {
        const args = request.params.arguments as { workspace?: string };
        
        // If we don't have workspaces config, we can't select a workspace
        if (!workspacesConfig || !workspacesConfig.workspaces || workspacesConfig.workspaces.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No workspaces are configured. Please set up workspaces in your configuration.",
              },
            ],
          };
        }
        
        // If workspace is provided, try to select it
        if (args?.workspace) {
          const workspace = findWorkspace(args.workspace);
          if (workspace) {
            workspacesConfig.activeWorkspaceId = workspace.id;
            
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    workspaces: workspacesConfig.workspaces.map((ws) => ({
                      id: ws.id,
                      name: ws.name,
                      email: ws.email,
                    })),
                    activeWorkspace: {
                      id: workspace.id,
                      name: workspace.name,
                      email: workspace.email,
                    },
                  }),
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `Workspace '${args.workspace}' not found. Available workspaces: ${workspacesConfig.workspaces.map((ws) => ws.name).join(", ")}`
                },
              ],
            };
          }
        }
        
        // If no workspace provided, just list all workspaces
        const activeWorkspace = workspacesConfig.workspaces.find(
          (ws) => ws.id === workspacesConfig?.activeWorkspaceId
        );
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                workspaces: workspacesConfig.workspaces.map((ws) => ({
                  id: ws.id,
                  name: ws.name,
                  email: ws.email,
                })),
                activeWorkspace: activeWorkspace ? {
                  id: activeWorkspace.id,
                  name: activeWorkspace.name,
                  email: activeWorkspace.email,
                } : undefined,
              }),
            },
          ],
        };
      }
      case "create_issue": {
        const args = request.params.arguments as CreateIssueArgs & { workspaceId?: string };
        const linearClient = getLinearClient(args.workspaceId);
        
        if (!args?.title || !args?.teamId) {
          throw new Error("Title and teamId are required");
        }
        
        const issue = await linearClient.createIssue({
          title: args.title,
          description: args.description,
          teamId: args.teamId,
          assigneeId: args.assigneeId,
          priority: args.priority,
          labelIds: args.labels,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      }

      case "list_issues": {
        const args = request.params.arguments as unknown as ListIssuesArgs & { workspaceId?: string };
        const linearClient = getLinearClient(args.workspaceId);

        const filter: any = {};
        if (args?.teamId) filter.team = { id: { eq: args.teamId } };
        if (args?.assigneeId) filter.assignee = { id: { eq: args.assigneeId } };
        if (args?.status) filter.state = { name: { eq: args.status } };

        const issues = await linearClient.issues({
          first: args?.first ?? 50,
          filter,
        });

        const formattedIssues = await Promise.all(
          issues.nodes.map(async (issue) => {
            const state = await issue.state;
            const assignee = await issue.assignee;
            return {
              id: issue.id,
              title: issue.title,
              status: state ? await state.name : "Unknown",
              assignee: assignee ? assignee.name : "Unassigned",
              priority: issue.priority,
              url: issue.url,
            };
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedIssues, null, 2),
            },
          ],
        };
      }

      case "update_issue": {
        const args = request.params.arguments as unknown as UpdateIssueArgs & { workspaceId?: string };
        const linearClient = getLinearClient(args.workspaceId);
        
        if (!args?.issueId) {
          throw new Error("Issue ID is required");
        }
        
        const issue = await linearClient.issue(args.issueId);
        if (!issue) {
          throw new Error(`Issue ${args.issueId} not found`);
        }

        const updatedIssue = await issue.update({
          title: args.title,
          description: args.description,
          stateId: args.status,
          assigneeId: args.assigneeId,
          priority: args.priority,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(updatedIssue, null, 2),
            },
          ],
        };
      }

      case "list_teams": {
        const args = request.params.arguments as unknown as { workspaceId?: string };
        const linearClient = getLinearClient(args.workspaceId);
        
        const query = await linearClient.teams();
        const teams = await Promise.all(
          (query as any).nodes.map(async (team: any) => ({
            id: team.id,
            name: team.name,
            key: team.key,
            description: team.description,
          }))
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(teams, null, 2),
            },
          ],
        };
      }

      case "list_projects": {
        const args = request.params.arguments as unknown as ListProjectsArgs & { workspaceId?: string };
        const linearClient = getLinearClient(args.workspaceId);
        
        const filter: Record<string, any> = {};
        if (args?.teamId) filter.team = { id: { eq: args.teamId } };

        const query = await linearClient.projects({
          first: args?.first ?? 50,
          filter,
        });

        const projects = await Promise.all(
          (query as any).nodes.map(async (project: any) => {
            const teamsConnection = await project.teams;
            const teams = teamsConnection ? (teamsConnection as any).nodes : [];
            return {
              id: project.id,
              name: project.name,
              description: project.description,
              state: project.state,
              teamIds: teams.map((team: any) => team.id),
            };
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      }

      case "search_issues": {
        const args = request.params.arguments as unknown as SearchIssuesArgs & { workspaceId?: string };
        if (!args?.query) {
          throw new Error("Search query is required");
        }
        
        const linearClient = getLinearClient(args.workspaceId);

        const searchResults = await linearClient.searchIssues(args.query, {
          first: args?.first ?? 50,
        });

        const formattedResults = await Promise.all(
          searchResults.nodes.map(async (result) => {
            const state = await result.state;
            const assignee = await result.assignee;
            return {
              id: result.id,
              title: result.title,
              status: state ? await state.name : "Unknown",
              assignee: assignee ? assignee.name : "Unassigned",
              priority: result.priority,
              url: result.url,
              metadata: result.metadata,
            };
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedResults, null, 2),
            },
          ],
        };
      }

      case "get_issue_status": {
        const args = request.params.arguments as { teamId: string; workspaceId?: string };
        const linearClient = getLinearClient(args.workspaceId);
        
        if (!args.teamId) {
          throw new Error("teamId is required");
        }
        
        const allStates: Array<{ id: string; name: string; description: string | null; position: number; type: string }> = [];
        let hasNextPage = true;
        let endCursor: string | null = null;
        
        while (hasNextPage) {
          const states = await linearClient.workflowStates({
            filter: { team: { id: { eq: args.teamId } } },
            after: endCursor,
            first: 100,
          });
          allStates.push(
            ...states.nodes.map((state: any) => ({
              id: state.id,
              name: state.name,
              description: state.description,
              position: state.position,
              type: state.type,
            }))
          );
          hasNextPage = states.pageInfo.hasNextPage;
          endCursor = states.pageInfo.endCursor ?? null;
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(allStates, null, 2)
            }
          ]
        };

      }
      case "get_issue": {
        const args = request.params.arguments as unknown as GetIssueArgs & { workspaceId?: string };
        const linearClient = getLinearClient(args.workspaceId);
        
        if (!args?.issueId) {
          throw new Error("Issue ID is required");
        }
        
        const issue = await linearClient.issue(args.issueId);
        if (!issue) {
          throw new Error(`Issue ${args.issueId} not found`);
        }

        try {
          const [
            state,
            assignee,
            creator,
            team,
            project,
            parent,
            cycle,
            labels,
            comments,
            attachments,
          ] = await Promise.all([
            issue.state,
            issue.assignee,
            issue.creator,
            issue.team,
            issue.project,
            issue.parent,
            issue.cycle,
            issue.labels(),
            issue.comments(),
            issue.attachments(),
          ]);

          const issueDetails: {
            id: string;
            identifier: string;
            title: string;
            description: string | undefined;
            priority: number;
            priorityLabel: string;
            status: string;
            url: string;
            createdAt: Date;
            updatedAt: Date;
            startedAt: Date | null;
            completedAt: Date | null;
            canceledAt: Date | null;
            dueDate: string | null;
            assignee: { id: string; name: string; email: string } | null;
            creator: { id: string; name: string; email: string } | null;
            team: { id: string; name: string; key: string } | null;
            project: { id: string; name: string; state: string } | null;
            parent: { id: string; title: string; identifier: string } | null;
            cycle: { id: string; name: string; number: number } | null;
            labels: Array<{ id: string; name: string; color: string }>;
            comments: Array<{ id: string; body: string; createdAt: Date }>;
            attachments: Array<{ id: string; title: string; url: string }>;
            embeddedImages: Array<{ url: string; analysis: string }>;
            estimate: number | null;
            customerTicketCount: number;
            previousIdentifiers: string[];
            branchName: string;
            archivedAt: Date | null;
            autoArchivedAt: Date | null;
            autoClosedAt: Date | null;
            trashed: boolean;
          } = {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            priority: issue.priority,
            priorityLabel: issue.priorityLabel,
            status: state ? await state.name : "Unknown",
            url: issue.url,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            startedAt: issue.startedAt || null,
            completedAt: issue.completedAt || null,
            canceledAt: issue.canceledAt || null,
            dueDate: issue.dueDate,
            assignee: assignee
              ? {
                  id: assignee.id,
                  name: assignee.name,
                  email: assignee.email,
                }
              : null,
            creator: creator
              ? {
                  id: creator.id,
                  name: creator.name,
                  email: creator.email,
                }
              : null,
            team: team
              ? {
                  id: team.id,
                  name: team.name,
                  key: team.key,
                }
              : null,
            project: project
              ? {
                  id: project.id,
                  name: project.name,
                  state: project.state,
                }
              : null,
            parent: parent
              ? {
                  id: parent.id,
                  title: parent.title,
                  identifier: parent.identifier,
                }
              : null,
            cycle:
              cycle && cycle.name
                ? {
                    id: cycle.id,
                    name: cycle.name,
                    number: cycle.number,
                  }
                : null,
            labels: await Promise.all(
              labels.nodes.map(async (label: any) => ({
                id: label.id,
                name: label.name,
                color: label.color,
              }))
            ),
            comments: await Promise.all(
              comments.nodes.map(async (comment: any) => ({
                id: comment.id,
                body: comment.body,
                createdAt: comment.createdAt,
              }))
            ),
            attachments: await Promise.all(
              attachments.nodes.map(async (attachment: any) => ({
                id: attachment.id,
                title: attachment.title,
                url: attachment.url,
              }))
            ),
            embeddedImages: [],
            estimate: issue.estimate || null,
            customerTicketCount: issue.customerTicketCount || 0,
            previousIdentifiers: issue.previousIdentifiers || [],
            branchName: issue.branchName || "",
            archivedAt: issue.archivedAt || null,
            autoArchivedAt: issue.autoArchivedAt || null,
            autoClosedAt: issue.autoClosedAt || null,
            trashed: issue.trashed || false,
          };

          // Extract embedded images from description
          const imageMatches =
            issue.description?.match(/!\[.*?\]\((.*?)\)/g) || [];
          if (imageMatches.length > 0) {
            issueDetails.embeddedImages = imageMatches.map((match) => {
              const url = (match as string).match(/\((.*?)\)/)?.[1] || "";
              return {
                url,
                analysis: "Image analysis would go here", // Replace with actual image analysis if available
              };
            });
          }

          // Add image analysis for attachments if they are images
          issueDetails.attachments = await Promise.all(
            attachments.nodes
              .filter((attachment: any) =>
                attachment.url.match(/\.(jpg|jpeg|png|gif|webp)$/i)
              )
              .map(async (attachment: any) => ({
                id: attachment.id,
                title: attachment.title,
                url: attachment.url,
                analysis: "Image analysis would go here", // Replace with actual image analysis if available
              }))
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(issueDetails, null, 2),
              },
            ],
          };
        } catch (error: any) {
          console.error("Error processing issue details:", error);
          throw new Error(`Failed to process issue details: ${error.message}`);
        }
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Method ${request.params.name} not found`
        );
    }
  } catch (error: any) {
    console.error("Linear API Error:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Linear MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
