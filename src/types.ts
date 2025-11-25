import type { SerializedBlindedMessage } from "@cashu/cashu-ts";

export type Request<TMethod extends string = string, TParams = unknown> = {
  method: TMethod;
  params?: TParams;
};

export type Response<TResult = unknown> =
  | { result: TResult; error?: never }
  | { result?: never; error: ResponseError };

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

export type BlindedSignaturesResult = {
  success: boolean;
  message: string;
  data: {
    preimageHash: string;
    blindedSignatures: { C_: string; id: string; amount: number }[];
  };
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
  make_invoice: {
    params: {
      amount: number;
      preimageHash: string;
      blindedMessages: SerializedBlindedMessage[];
      dealerPubkey: string;
    };
    result: { success: boolean; message: string; data: { invoice: string } };
  };
  blinded_signatures: {
    params: {
      preimageHash: string;
      blindedSignatures: { C_: string; id: string; amount: number }[];
    };
    result: { success: boolean; message: string };
  };
  request_dealer_fee: {
    params: { preimage: string; preimageHash: string; amount: number };
    result: {
      success: boolean;
      feeAmount: number;
      blindedMessages: SerializedBlindedMessage[];
    };
  };
  swap_htlc: {
    params: {
      htlcToken: string;
      blindedMessages: SerializedBlindedMessage[];
      requestPreimageHash: string;
      preimage: string;
      alicePubkey: string;
    };
    result: {
      success: boolean;
      message: string;
    };
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

export type SigFlag = "SIG_INPUTS" | "SIG_ALL";

export type HTLCConfig = {
  /** The hash to lock the HTLC to (32 byte hex string, 64 characters) */
  preimageHash: string;
  /** Signature flag - must be SIG_ALL for HTLC */
  sigflag?: "SIG_ALL";
  /** Array of public keys that can unlock before locktime (dealer pubkeys) */
  pubkeys?: string[];
  /** Minimum number of public keys required to provide valid signatures */
  n_sigs?: number;
  /** Unix timestamp in seconds of when the lock expires */
  locktime?: number;
  /** Array of refund public keys that can exclusively spend after locktime (gateway pubkeys) */
  refund?: string[];
  /** Minimum number of refund public keys required to provide valid signatures */
  n_sigs_refund?: number;
};
