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
    inputs: [
      {
        name: "_payment",
        type: "tuple",
        components: [
          { name: "merkleProof", type: "bytes32[]" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "attestationType", type: "bytes32" },
              { name: "sourceId", type: "bytes32" },
              { name: "votingRound", type: "uint64" },
              { name: "lowestUsedTimestamp", type: "uint64" },
              {
                name: "requestBody",
                type: "tuple",
                components: [
                  { name: "transactionId", type: "bytes32" },
                  { name: "inUtxo", type: "uint256" },
                  { name: "utxo", type: "uint256" },
                ],
              },
              {
                name: "responseBody",
                type: "tuple",
                components: [
                  { name: "blockNumber", type: "uint64" },
                  { name: "blockTimestamp", type: "uint64" },
                  { name: "sourceAddressHash", type: "bytes32" },
                  { name: "sourceAddressesRoot", type: "bytes32" },
                  { name: "receivingAddressHash", type: "bytes32" },
                  { name: "intendedReceivingAddressHash", type: "bytes32" },
                  { name: "spentAmount", type: "int256" },
                  { name: "intendedSpentAmount", type: "int256" },
                  { name: "receivedAmount", type: "int256" },
                  { name: "intendedReceivedAmount", type: "int256" },
                  { name: "standardPaymentReference", type: "bytes32" },
                  { name: "oneToOne", type: "bool" },
                  { name: "status", type: "uint8" },
                ],
              },
            ],
          },
        ],
      },
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

// --- FDC (Flare Data Connector) — Coston2 testnet ---------------------------
export const FDC_HUB = "0x48aC463d7975828989331F4De43341627b9c5f1D";
export const FDC_FEE_CONFIG = "0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e";
export const FDC_VERIFIER = "https://fdc-verifiers-testnet.flare.network";
export const FDC_DA_LAYER = "https://ctn2-data-availability.flare.network";
export const FDC_API_KEY = "00000000-0000-0000-0000-000000000000"; // public testnet key
// votingRoundId = floor((collectTimestamp - FIRST_VOTING_ROUND_START) / ROUND_SECS)
export const FDC_FIRST_ROUND_TS = 1658430000;
export const FDC_ROUND_SECS = 90;

export const fdcHubAbi = [
  {
    type: "function",
    name: "requestAttestation",
    stateMutability: "payable",
    inputs: [{ name: "_data", type: "bytes" }],
    outputs: [],
  },
];

export const fdcFeeConfigAbi = [
  {
    type: "function",
    name: "getRequestFee",
    stateMutability: "view",
    inputs: [{ name: "_data", type: "bytes" }],
    outputs: [{ name: "_fee", type: "uint256" }],
  },
];

// Minimal ERC20 for moving the minted FXRP into the vault.
export const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
