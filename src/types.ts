export type Request<TMethod extends string = string, TParams = unknown> = {
  method: TMethod;
  params?: TParams;
};

export type Response<TResult = unknown> = {
  result?: TResult;
  error?: ResponseError;
};

export type ResponseError = {
  code: number;
  message: string;
  data?: unknown;
};

export type InfoResult = {
  type: "alice" | "gateway" | "dealer";
  name: string;
  timestamp: number;
};

export type PayInvoiceResult = {
  success: boolean;
  message: string;
  data: { preimage: string };
};

export type MethodMap = {
  info: {
    params: undefined;
    result: InfoResult;
  };
  pay_invoice: {
    params: { invoice: string; token: string };
    result: PayInvoiceResult;
  };
};

export type Methods = keyof MethodMap;

export type RequestForMethod<M extends Methods> = Request<M, MethodMap[M]["params"]>;
export type ResponseForMethod<M extends Methods> = Response<MethodMap[M]["result"]>;

export function isRequestForMethod<M extends Methods>(
  request: Request,
  method: M
): request is RequestForMethod<M> {
  return request.method === method;
}

export function createResponse<M extends Methods>(
  result: MethodMap[M]["result"]
): ResponseForMethod<M> {
  return { result } as ResponseForMethod<M>;
}

export function createErrorResponse<M extends Methods>(
  code: number,
  message: string,
  data?: unknown
): ResponseForMethod<M> {
  return { error: { code, message, data } } as ResponseForMethod<M>;
}

export type InfoRequest = RequestForMethod<"info">;
export type InfoResponse = ResponseForMethod<"info">;
export type PayInvoiceRequest = RequestForMethod<"pay_invoice">;
export type PayInvoiceResponse = ResponseForMethod<"pay_invoice">;
