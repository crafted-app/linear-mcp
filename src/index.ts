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

// Parse ACCOUNTS environment variable or fall back to LINEAR_API_KEY
let accountsConfig: {
  accounts: Array<{
    email: string;
    apiKey: string;
    workspaces?: Array<{ name: string; aliases: string; }>;
  }>;
  activeEmail?: string;
} | null = null;

try {
  if (process.env.ACCOUNTS) {
    accountsConfig = JSON.parse(process.env.ACCOUNTS);
  }
} catch (error) {
  console.error("Error parsing ACCOUNTS environment variable:", error);
  console.error("Please check the JSON format of your ACCOUNTS environment variable.");
  process.exit(1);
}

// Fall back to LINEAR_API_KEY if ACCOUNTS is not provided
const API_KEY = process.env.LINEAR_API_KEY || process.env.LINEARAPIKEY;
if (!accountsConfig && !API_KEY) {
  console.error("Error: Either ACCOUNTS or LINEAR_API_KEY environment variable is required");
  console.error("");
  console.error("To use multiple accounts, set the ACCOUNTS environment variable with JSON format:");
  console.error("ACCOUNTS='{");
  console.error("  \"accounts\": [");
  console.error("    {");
  console.error("      \"email\": \"work@example.com\",");
  console.error("      \"apiKey\": \"your_work_api_key_here\",");
  console.error("      \"workspaces\": [");
  console.error("        { \"name\": \"Work Project\", \"aliases\": \"work, main\" }");
  console.error("      ]");
  console.error("    },");
  console.error("    {");
  console.error("      \"email\": \"personal@example.com\",");
  console.error("      \"apiKey\": \"your_personal_api_key_here\",");
  console.error("      \"workspaces\": [");
  console.error("        { \"name\": \"Personal Project\", \"aliases\": \"personal, side\" }");
  console.error("      ]");
  console.error("    }");
  console.error("  ],");
  console.error("  \"activeEmail\": \"work@example.com\"");
  console.error("}'");
  console.error("");
  console.error("Or, to use a single account, set LINEAR_API_KEY:");
  console.error("LINEAR_API_KEY=your-api-key npx @ibraheem4/linear-mcp");
  console.error("");
  console.error("Or set it in your environment:");
  console.error("export LINEAR_API_KEY=your-api-key");
  console.error("npx @ibraheem4/linear-mcp");
  process.exit(1);
}

// Create a map of LinearClient instances by email
const linearClients = new Map<string, LinearClient>();

// Initialize clients for multi-account setup
if (accountsConfig && accountsConfig.accounts && accountsConfig.accounts.length > 0) {
  for (const account of accountsConfig.accounts) {
    linearClients.set(account.email, new LinearClient({
      apiKey: account.apiKey,
    }));
  }
} else if (API_KEY) {
  // Fall back to single account if ACCOUNTS is not available
  const defaultEmail = "default@linear-mcp.local";
  linearClients.set(defaultEmail, new LinearClient({
    apiKey: API_KEY,
  }));
  
  if (!accountsConfig) {
    accountsConfig = {
      accounts: [
        {
          email: defaultEmail,
          apiKey: API_KEY
        }
      ],
      activeEmail: defaultEmail
    };
  }
}

// Function to get the active linear client
const getLinearClient = (email?: string): LinearClient => {
  // If email is provided, use that client
  if (email && linearClients.has(email)) {
    return linearClients.get(email)!;
  }
  
  // If no email provided, use the active email from config
  if (accountsConfig?.activeEmail && linearClients.has(accountsConfig.activeEmail)) {
    return linearClients.get(accountsConfig.activeEmail)!;
  }
  
  // If no active email in config, use the first account
  if (accountsConfig?.accounts && accountsConfig.accounts.length > 0 && accountsConfig.accounts[0].email) {
    return linearClients.get(accountsConfig.accounts[0].email)!;
  }
  
  throw new Error("No Linear client available. Please check your configuration.");
};

// The default linearClient for backward compatibility
const linearClient = getLinearClient();

// Helper to find a workspace by name or alias
const findWorkspace = (nameOrAlias: string): { email: string; workspace: { name: string; aliases: string } } | null => {
  if (!accountsConfig || !accountsConfig.accounts) return null;
  
  const lowercaseSearch = nameOrAlias.toLowerCase();
  
  for (const account of accountsConfig.accounts) {
    if (!account.workspaces) continue;
    
    for (const workspace of account.workspaces) {
      // Check if the name matches
      if (workspace.name.toLowerCase() === lowercaseSearch) {
        return { email: account.email, workspace };
      }
      
      // Check if any alias matches
      const aliases = workspace.aliases.split(',').map((a: string) => a.trim().toLowerCase());
      if (aliases.includes(lowercaseSearch)) {
        return { email: account.email, workspace };
      }
    }
  }
  
  return null;
};

const server = new Server(
  {
    name: "linear-mcp",
    version: "39.0.0", // Match Linear SDK version
  },
  {
    capabilities: {
      tools: {
        select_account: true,
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
      name: "select_account",
      description: "Select an account to use for Linear operations",
      inputSchema: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "Email address associated with the Linear account",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to select (if provided, finds the account associated with this workspace)",
          },
        },
        required: [],
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
          email: {
            type: "string",
            description: "Email of the Linear account to use (optional)",
          },
          workspace: {
            type: "string",
            description: "Workspace name or alias to use (optional)",
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
      case "select_account": {
        const args = request.params.arguments as { email?: string; workspace?: string };
        
        // If we don't have accounts config, we can't select an account
        if (!accountsConfig || !accountsConfig.accounts || accountsConfig.accounts.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No accounts configured. Please set up the ACCOUNTS environment variable."
              }
            ]
          };
        }

        // If workspace is provided, find the account associated with that workspace
        if (args.workspace) {
          const result = findWorkspace(args.workspace);
          if (result) {
            accountsConfig.activeEmail = result.email;
            
            return {
              content: [
                {
                  type: "json",
                  json: {
                    account: result.email,
                    workspace: result.workspace.name,
                    status: "selected"
                  }
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `No account found for workspace "${args.workspace}"`
                }
              ]
            };
          }
        }
        
        // If email is provided, check if it's a valid account
        if (args.email) {
          const account = accountsConfig.accounts.find(a => a.email === args.email);
          if (account) {
            accountsConfig.activeEmail = account.email;
            
            return {
              content: [
                {
                  type: "json",
                  json: {
                    account: account.email,
                    status: "selected",
                    workspaces: account.workspaces?.map(ws => ws.name) || []
                  }
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `Account with email ${args.email} not found`
                }
              ]
            };
          }
        }
        
        // If no parameters are provided, list all available accounts
        return {
          content: [
            {
              type: "text",
              text: "Available accounts:"
            },
            {
              type: "json",
              json: accountsConfig.accounts.map(account => ({
                account: account.email,
                workspaces: account.workspaces?.map(ws => ws.name) || [],
                is_active: account.email === accountsConfig?.activeEmail,
              }))
            }
          ]
        };
      }
      case "create_issue": {
        const args = request.params.arguments as unknown as CreateIssueArgs & { email?: string; workspace?: string };
        if (!args?.title || !args?.teamId) {
          throw new Error("Title and teamId are required");
        }
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;

        const issue = await client.createIssue({
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
        const args = request.params.arguments as unknown as ListIssuesArgs & { email?: string; workspace?: string };

        const filter: any = {};
        if (args?.teamId) filter.team = { id: { eq: args.teamId } };
        if (args?.assigneeId) filter.assignee = { id: { eq: args.assigneeId } };
        if (args?.status) filter.state = { name: { eq: args.status } };
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;

        const issues = await client.issues({
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
        const args = request.params.arguments as unknown as UpdateIssueArgs & { email?: string; workspace?: string };
        if (!args?.issueId) {
          throw new Error("Issue ID is required");
        }
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;

        const issue = await client.issue(args.issueId);
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
        const args = request.params.arguments as { email?: string; workspace?: string };
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;
        
        const query = await client.teams();
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
        const args = request.params.arguments as unknown as ListProjectsArgs & { email?: string; workspace?: string };
        const filter: Record<string, any> = {};
        if (args?.teamId) filter.team = { id: { eq: args.teamId } };
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;

        const query = await client.projects({
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
        const args = request.params.arguments as unknown as SearchIssuesArgs & { email?: string; workspace?: string };
        if (!args?.query) {
          throw new Error("Search query is required");
        }
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;

        const searchResults = await client.searchIssues(args.query, {
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
        const args = request.params.arguments as { teamId: string; email?: string; workspace?: string };
        if (!args.teamId) {
          throw new Error("teamId is required");
        }
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;
        const allStates: Array<{ id: string; name: string; description: string | null; position: number; type: string }> = [];
        let hasNextPage = true;
        let endCursor: string | null = null;
        while (hasNextPage) {
          const states = await client.workflowStates({
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
        const args = request.params.arguments as unknown as GetIssueArgs & { email?: string; workspace?: string };
        if (!args?.issueId) {
          throw new Error("Issue ID is required");
        }
        
        // Determine which account to use
        let clientEmail = args.email;
        
        // If workspace is specified, find the account for that workspace
        if (args.workspace && !clientEmail) {
          const found = findWorkspace(args.workspace);
          if (found) {
            clientEmail = found.email;
          } else {
            throw new Error(`No account found for workspace "${args.workspace}"`);  
          }
        }
        
        // Get the client for the specified email or use default
        const client = clientEmail ? getLinearClient(clientEmail) : linearClient;

        const issue = await client.issue(args.issueId);
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
          `Unknown tool: ${request.params.name}`
        );
    }
  } catch (error: any) {
    console.error("Linear API Error:", error);
    return {
      content: [
        {
          type: "text",
          text: `Linear API error: ${error.message}`,
        },
      ],
      isError: true,
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
