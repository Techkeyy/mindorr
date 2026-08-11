// Minimal AssetManagerFXRP ABI — only the functions/events the mint uses.
// AssetManagerFXRP (diamond) = 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA on Coston2.
// Signatures verified against the live contract: lotSize()=1e7, the 4-arg
// reserveCollateral selector exists (probe reverted with a business error, not
// FunctionNotFound). CollateralReserved / executeMinting from fassets `main`.
export const assetManagerAbi = [
  {
    type: "function",
    name: "lotSize",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "_lotSizeUBA", type: "uint256" }],
  },
  {
    type: "function",
    name: "collateralReservationFee",
    stateMutability: "view",
    inputs: [{ name: "_lots", type: "uint256" }],
    outputs: [{ name: "_feeNATWei", type: "uint256" }],
  },
  {
    type: "function",
    name: "getAvailableAgentsList",
    stateMutability: "view",
    inputs: [
      { name: "_start", type: "uint256" },
      { name: "_end", type: "uint256" },
    ],
    outputs: [
      { name: "_agents", type: "address[]" },
      { name: "_totalLength", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "reserveCollateral",
    stateMutability: "payable",
    inputs: [
      { name: "_agentVault", type: "address" },
      { name: "_lots", type: "uint256" },
      { name: "_maxMintingFeeBIPS", type: "uint256" },
      { name: "_executor", type: "address" },
    ],
    outputs: [{ name: "_collateralReservationId", type: "uint256" }],
  },
  {
    type: "function",
    name: "executeMinting",
    stateMutability: "nonpayable",
    // IPayment.Proof is (bytes32[] merkleProof, Payment.Response data). We pass it
    // as a pre-built tuple from the FDC step; typed loosely here and encoded there.
    inputs: [
      { name: "_payment", type: "bytes" },
      { name: "_collateralReservationId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "CollateralReserved",
    inputs: [
      { name: "agentVault", type: "address", indexed: true },
      { name: "minter", type: "address", indexed: true },
      { name: "collateralReservationId", type: "uint256", indexed: true },
      { name: "valueUBA", type: "uint256", indexed: false },
      { name: "feeUBA", type: "uint256", indexed: false },
      { name: "firstUnderlyingBlock", type: "uint256", indexed: false },
      { name: "lastUnderlyingBlock", type: "uint256", indexed: false },
      { name: "lastUnderlyingTimestamp", type: "uint256", indexed: false },
      { name: "paymentAddress", type: "string", indexed: false },
      { name: "paymentReference", type: "bytes32", indexed: false },
      { name: "executor", type: "address", indexed: false },
      { name: "executorFeeNatWei", type: "uint256", indexed: false },
    ],
  },
];

export const coston2 = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] } },
};

export const ASSET_MANAGER_FXRP = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA";
export const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
