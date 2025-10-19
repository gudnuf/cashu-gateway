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

export type InfoRequest = Request<"info">;

export type InfoResult = {
  type: "alice" | "gateway" | "dealer";
  name: string;
  timestamp: number;
};

export type InfoResponse = Response<InfoResult>;
