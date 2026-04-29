import { LlmProvider, LlmRequest, LlmResponse, ChatMessage, ToolDefinition } 
from './types';
import { HttpClient } from '../http-client.js';
import type { GatewayConfig, OciProviderConfig, OciAuthConfig, OciChatConfig } from '../config/env.js';
import { logger } from '../observability/logger';

interface OciTokenResponse {
    access_token: string;
    expires_in: number;
}

interface OciAuthResponse {
    result: OciTokenResponse;
}

interface OciTool {
    name: string;
    description: string;
    parameterDefinitions?: Record<string, {
        description?: string;
        type: string;
        required?: boolean;
    }>;
}

interface OciChatRequest {
    compartmentId: string;
    servingMode: {
        servingType: string;
        endpointId: string;
    };
    chatRequest: {
        message: string;
        apiFormat: string;
        preambleOverride?: string;
        documents?: { title: string; snippet: string; website: string }[];
        chatHistory?: { role: string; message: string }[];
        tools?: OciTool[];
    };
}

interface OciChatResponse {
    result: {
        chatResponse: {
            text: string;
            chatHistory: { role: string; message: string }[];
            finishReason: string;
            toolCalls?: {
                name: string;
                parameters: Record<string, unknown>;
            }[];
            usage: {
                completionTokens: string;
                promptTokens: string;
                totalTokens: string;
            };
        };
    };
}

export class OciProvider implements LlmProvider {
    readonly name = 'oci';
    private readonly client: HttpClient;
    private readonly authConfig: OciAuthConfig;
    private readonly chatConfig: OciChatConfig;
    private accessToken: string | null = null;
    private tokenExpiry: number | null = null;

    constructor(config: GatewayConfig) {
        const ociConfig = config.llm.providers.oci as OciProviderConfig;
        if (!ociConfig) {
            throw new Error('OCI provider configuration is missing.');
        }
        this.client = new HttpClient();
        this.authConfig = ociConfig.auth;
        this.chatConfig = {
            ...ociConfig.chat,
            // Inherit SSL bypass from auth config if not explicitly set
            rejectUnauthorized: ociConfig.chat.rejectUnauthorized ?? ociConfig.auth.rejectUnauthorized
        };
    }

    async chat(request: LlmRequest): Promise<LlmResponse> {
        // Only fetch a new token if not present or expired
        if (!this.accessToken || !this.tokenExpiry || Date.now() >= this.tokenExpiry) {
            await this.ensureAuthenticated();
        }

        const ociRequest = this.createOciRequest(request);
        
        logger.info({ 
            ociRequest,
            chatUrl: this.chatConfig.url 
        }, 'Sending OCI chat request');

        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
        };

        const options: { headers: Record<string, string>; rejectUnauthorized?: boolean } = { headers };
        if (this.chatConfig.rejectUnauthorized !== undefined) {
            options.rejectUnauthorized = this.chatConfig.rejectUnauthorized;
        }

        try {
            const response = await this.client.post<OciChatResponse>(this.chatConfig.url, ociRequest, options);
            logger.info({ response }, 'OCI chat response received');
            const llmResponse = this.toLlmResponse(response);
            logger.info({ llmResponse }, 'Converted to LLM response format');
            return llmResponse;
        } catch (error) {
            logger.error({ error, ociRequest }, 'Error during OCI chat request');
            throw new Error('Failed to get response from OCI provider');
        }
    }

    private async ensureAuthenticated(): Promise<void> {
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return;
        }

        const authPayload = {
            username: this.authConfig.username,
            password: this.authConfig.password,
            grant_type: this.authConfig.grantType
        };

        try {
            const options: { rejectUnauthorized?: boolean } = {};
            if (this.authConfig.rejectUnauthorized !== undefined) {
                options.rejectUnauthorized = this.authConfig.rejectUnauthorized;
            }
            
            logger.info({ 
                url: this.authConfig.url,
                payload: { ...authPayload, password: '***' },
                rejectUnauthorized: options.rejectUnauthorized 
            }, 'Attempting OCI authentication');
            
            const response = await this.client.post<OciAuthResponse>(
                this.authConfig.url, 
                authPayload,
                options
            );
            
            logger.info({ response }, 'OCI auth response received');
            
            const tokenData = response.result;
            this.accessToken = tokenData.access_token;
            // Set expiry with a 5-minute buffer
            this.tokenExpiry = Date.now() + (tokenData.expires_in - 300) * 1000;
            logger.info('Successfully authenticated with OCI.');
        } catch (error) {
            logger.error({ error, authUrl: this.authConfig.url }, 'OCI authentication failed');
            throw new Error('Failed to authenticate with OCI');
        }
    }

    private createOciRequest(request: LlmRequest): OciChatRequest {
        const lastUserMessage = request.messages.at(-1)!;
        
        // Extract system message (preamble) if present
        const systemMessage = request.messages.find((m: ChatMessage) => m.role === 'system');
        
        // Filter chat history: exclude system messages, exclude the last user message (it goes in 'message'),
        // and exclude empty messages. Also ensure alternating USER/ASSISTANT pattern.
        const filteredMessages = request.messages
            .slice(0, -1)  // Exclude last message (it's in the 'message' field)
            .filter((m: ChatMessage) => {
                // Only include USER and ASSISTANT roles
                if (m.role !== 'user' && m.role !== 'assistant') {
                    return false;
                }
                // Exclude empty messages
                if (!m.content || m.content.trim() === '') {
                    return false;
                }
                return true;
            });

        // Ensure alternating pattern by removing consecutive messages with the same role
        const chatHistory: { role: string; message: string }[] = [];
        let lastRole: string | null = null;
        
        for (const m of filteredMessages) {
            // Map assistant to CHATBOT (Cohere's terminology)
            const role = m.role === 'assistant' ? 'CHATBOT' : m.role.toUpperCase();
            // Skip if same role as previous message (to maintain alternation)
            if (role === lastRole) {
                continue;
            }
            chatHistory.push({
                role: role,
                message: m.content,
            });
            lastRole = role;
        }

        const ociRequest: OciChatRequest = {
            compartmentId: this.chatConfig.compartmentId,
            servingMode: {
                servingType: this.chatConfig.servingType,
                endpointId: this.chatConfig.endpointId,
            },
            chatRequest: {
                message: lastUserMessage.content,
                apiFormat: this.chatConfig.apiFormat,
            },
        };

        // Add system prompt as preambleOverride if present
        if (systemMessage?.content) {
            ociRequest.chatRequest.preambleOverride = systemMessage.content;
        }

        // Only add chatHistory if there are actual messages
        if (chatHistory.length > 0) {
            ociRequest.chatRequest.chatHistory = chatHistory;
        }

        // Transform tools to Cohere format if present
        if (request.tools && request.tools.length > 0) {
            ociRequest.chatRequest.tools = this.transformToolsToCohere(request.tools);
            logger.info({ toolCount: request.tools.length }, 'Added tools to OCI request');
        }

        logger.info({ ociRequest }, 'Full OCI request to LLM');
        return ociRequest;
    }

    /**
     * Transform ToolDefinition[] to Cohere's tool format.
     * Cohere uses parameterDefinitions instead of parameters.properties,
     * and each parameter has a flattened structure with required as a boolean.
     */
    private transformToolsToCohere(tools: ToolDefinition[]): OciTool[] {
        return tools.map(tool => {
            const ociTool: OciTool = {
                name: tool.name,
                description: tool.description,
            };

            // Convert JSON Schema parameters to Cohere's parameterDefinitions format
            if (tool.parameters?.properties) {
                const parameterDefinitions: Record<string, { description?: string; type: string; required?: boolean }> = {};
                
                for (const [paramName, paramSchema] of Object.entries(tool.parameters.properties)) {
                    parameterDefinitions[paramName] = {
                        description: paramSchema.description,
                        type: paramSchema.type,
                        required: tool.parameters.required?.includes(paramName) ?? false,
                    };
                }
                
                ociTool.parameterDefinitions = parameterDefinitions;
            }

            return ociTool;
        });
    }

    private toLlmResponse(response: OciChatResponse): LlmResponse {
        const chatResponse = response.result.chatResponse;
        
        // Use the text field directly from the response
        const assistantMessage = chatResponse.text;

        // Map OCI tool calls to LlmResponse tool calls
        const toolCalls = chatResponse.toolCalls?.map((tc, index) => ({
            id: `call_${Date.now()}_${index}`, // Generate unique ID
            name: tc.name,
            arguments: tc.parameters
        }));

        return {
            text: assistantMessage,
            toolCalls,
            meta: {
                finishReason: chatResponse.finishReason,
                usage: {
                    completionTokens: Number.parseInt(chatResponse.usage.completionTokens, 10),
                    promptTokens: Number.parseInt(chatResponse.usage.promptTokens, 10),
                    totalTokens: Number.parseInt(chatResponse.usage.totalTokens, 10),
                }
            }
        };
    }
}
