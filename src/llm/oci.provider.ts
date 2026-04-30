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

interface CohereToolCall {
    name: string;
    parameters: Record<string, unknown>;
}

interface CohereToolResult {
    call: CohereToolCall;
    outputs: Array<Record<string, unknown>>;
}

interface OciChatRequest {
    compartmentId: string;
    servingMode: {
        servingType: string;
        endpointId: string;
    };
    chatRequest: {
        message?: string;
        apiFormat: string;
        preambleOverride?: string;
        documents?: { title: string; snippet: string; website: string }[];
        chatHistory?: Array<{ role: string; message?: string; toolResults?: CohereToolResult[] }>;
        tools?: OciTool[];
        toolResults?: CohereToolResult[];
    };
}

interface OciChatResponse {
    result: {
        chatResponse: {
            text: string;
            chatHistory: { role: string; message: string }[];
            finishReason: string;
            toolCalls?: CohereToolCall[];
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
        // Extract system message (preamble) if present
        const systemMessage = request.messages.find((m: ChatMessage) => m.role === 'system');
        
        // Extract tool results from the conversation if present
        const toolResults = this.extractToolResults(request.messages, request);
        
        // Get the last user message (only used if no tool results)
        const lastUserMessage = request.messages.at(-1)!;
        
        // OPTIMIZATION: If previousResponse contains ociChatHistory, reuse it directly
        // instead of re-parsing messages. This is the entire point of the refactoring -
        // OCI already gave us the perfect chatHistory in the last response.
        let chatHistory: { role: string; message?: string; toolResults?: CohereToolResult[] }[] = [];
        
        if (request.previousResponse?.meta?.ociChatHistory) {
            // Direct copy - no parsing, no rebuilding, just reuse OCI's exact data
            chatHistory = request.previousResponse.meta.ociChatHistory as { role: string; message?: string; toolResults?: CohereToolResult[] }[];
            logger.info({ historyCount: chatHistory.length }, 'Reusing OCI chatHistory from previous response');
        } 

        const ociRequest: OciChatRequest = {
            compartmentId: this.chatConfig.compartmentId,
            servingMode: {
                servingType: this.chatConfig.servingType,
                endpointId: this.chatConfig.endpointId,
            },
            chatRequest: {
                apiFormat: this.chatConfig.apiFormat,
            },
        };

        // When tool results exist, message should be empty (tool results represent the continuation)
        // When no tool results, use the actual user message
        if (toolResults.length > 0) {
            ociRequest.chatRequest.message = '';
        } else {
            ociRequest.chatRequest.message = lastUserMessage.content ?? '';
        }

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

        // Add tool results if present
        if (toolResults.length > 0) {
            ociRequest.chatRequest.toolResults = toolResults;
            logger.info({ toolResultsCount: toolResults.length }, 'Added tool results to OCI request');
        }

        return ociRequest;
    }

    /**
     * Extract tool results from previousResponse meta.
     * OCI stores toolResults directly in meta.ociToolResults after orchestrator
     * execution, so we just read them - https://docs.oracle.com/en-us/iaas/api/#/en/generative-ai-inference/20231130/datatypes/CohereToolMessageno message parsing needed.
     */
    private extractToolResults(messages: ChatMessage[], request: LlmRequest): CohereToolResult[] {
        // Direct read from meta - orchestrator populates this
        return (request.previousResponse?.meta?.ociToolResults as CohereToolResult[] | undefined) ?? [];
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

        // If there are tool calls, build both formats
        if (chatResponse.toolCalls && chatResponse.toolCalls.length > 0) {
            const toolCalls = chatResponse.toolCalls.map((tc, index) => ({
                id: `call_${Date.now()}_${index}`,
                name: tc.name,
                arguments: tc.parameters
            }));

            const assistantToolCalls = chatResponse.toolCalls.map((tc, index) => ({
                id: `call_${Date.now()}_${index}`,
                name: tc.name,
                arguments: JSON.stringify(tc.parameters)
            }));

            return {
                toolCalls,
                meta: {
                    finishReason: chatResponse.finishReason,
                    usage: {
                        completionTokens: Number.parseInt(chatResponse.usage.completionTokens, 10),
                        promptTokens: Number.parseInt(chatResponse.usage.promptTokens, 10),
                        totalTokens: Number.parseInt(chatResponse.usage.totalTokens, 10),
                    },
                    assistantMessage: {
                        role: "assistant" as const,
                        content: assistantMessage ?? "",
                        toolCalls: assistantToolCalls,
                    },
                    // Preserve OCI's chatHistory for reuse in subsequent rounds
                    ociChatHistory: chatResponse.chatHistory,
                    // Store raw OCI toolCalls in native Cohere format for direct reuse
                    ociToolCalls: chatResponse.toolCalls,
                    // Will be populated by orchestrator after tool execution
                    ociToolResults: []
                }
            };
        }

        return {
            text: assistantMessage,
            meta: {
                finishReason: chatResponse.finishReason,
                usage: {
                    completionTokens: Number.parseInt(chatResponse.usage.completionTokens, 10),
                    promptTokens: Number.parseInt(chatResponse.usage.promptTokens, 10),
                    totalTokens: Number.parseInt(chatResponse.usage.totalTokens, 10),
                },
                // Preserve OCI's chatHistory for reuse in subsequent rounds
                ociChatHistory: chatResponse.chatHistory
            }
        };
    }
}
