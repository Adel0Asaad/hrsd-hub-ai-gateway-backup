// ai-gateway/src/http-client.ts

import { logger } from "./observability/logger.js";
import https from "node:https";
import { URL } from "node:url";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
  rejectUnauthorized?: boolean;
}

export class HttpClient {
  async request<T>(
    method: HttpMethod,
    url: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    // If rejectUnauthorized is explicitly set to false, use native https module
    // because fetch() doesn't support custom agents properly in all Node versions
    if (options.rejectUnauthorized === false) {
      logger.debug({ url, method, rejectUnauthorized: false }, 'Using native https module for SSL bypass');
      return this.requestWithHttpsModule<T>(method, url, body, options);
    }

    const controller = new AbortController();
    const timeoutId = options.timeout
      ? setTimeout(() => controller.abort(), options.timeout)
      : null;

    try {
      logger.debug({ url, method, bodySize: body ? JSON.stringify(body).length : 0 }, 'Sending HTTP request');
      
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          {
            status: response.status,
            statusText: response.statusText,
            url,
            body: errorBody,
          },
          `HTTP request failed: ${response.statusText}`
        );
        throw new Error(`HTTP request failed: ${response.status} ${response.statusText}`);
      }

      // Handle cases where the response body might be empty
      const responseText = await response.text();
      return responseText ? (JSON.parse(responseText) as T) : ({} as T);

    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      logger.error({ err: error, url, method }, "HTTP request threw an exception.");
      throw error;
    }
  }

  async get<T>(url: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", url, undefined, options);
  }

  async post<T>(
    url: string,
    body: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    return this.request<T>("POST", url, body, options);
  }

  /**
   * Native https module fallback for requests that need SSL bypass.
   * Used when rejectUnauthorized: false is specified.
   */
  private async requestWithHttpsModule<T>(
    method: HttpMethod,
    urlString: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const bodyData = body ? JSON.stringify(body) : undefined;

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyData && { 'Content-Length': Buffer.byteLength(bodyData) }),
          ...options.headers,
        },
        rejectUnauthorized: false,
      };

      logger.debug({ requestOptions }, 'Native HTTPS request options');

      const req = https.request(requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            logger.debug({ statusCode: res.statusCode, dataLength: data.length }, 'Native HTTPS response received');
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode && res.statusCode >= 400) {
              logger.error({ statusCode: res.statusCode, body: parsed }, 'Native HTTPS request failed');
              reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
            } else {
              resolve(parsed as T);
            }
          } catch (err) {
            logger.error({ err, data }, 'Failed to parse native HTTPS response');
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        logger.error({ err }, 'Native HTTPS request error');
        reject(err);
      });

      if (options.timeout) {
        req.setTimeout(options.timeout, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      }

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  }
}
