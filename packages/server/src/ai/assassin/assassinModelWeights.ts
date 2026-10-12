/**
 * 刺殺模型權重 — 由 `scripts/assassinModel.ts --write` 產生，請勿手改。
 * 2026-10-12 sheets_cache 1048 games (train 731), λ=0.1
 * 測試集刺中率等數字見 docs/ai/strength_benchmark.md。
 */
import type { AssassinModelWeights } from './AssassinModel';

export const ASSASSIN_MODEL_WEIGHTS: AssassinModelWeights = {
  version: "2026-10-12 sheets_cache 1048 games (train 731), λ=0.1",
  features: [
    "propRate",
    "succMissions",
    "failMissions",
    "cleanRecord",
    "lastSuccessTeam",
    "r1Mission",
    "onTeamWithEvilRate",
    "pickedByEvilRate",
    "offApproveRate",
    "onRejectRate",
    "rejectSelfTeamRate",
    "approveSelfTeamOff",
    "rejectAllyTeamRate",
    "approveAllyTeamOff",
    "approveCleanOffRate",
    "rejectCleanOnRate",
    "voteOutcomeAgreeRate",
    "agreeWithAssassinRate",
    "ledRate",
    "ledWithSelfRate",
    "ledWithAllyRate",
    "ledCleanCount",
    "ledApprovedRate",
    "lakedByEvilGood",
    "lakedByEvilEvil",
    "lakedByOtherGood",
    "lakedByOtherEvil",
    "heldLake",
    "lakeTargetEvil",
    "seat1",
    "seat2",
    "seat3",
    "seat4",
    "seat5",
    "seat6",
    "seat7",
    "seat8",
    "seat9",
    "seat10",
  ],
  weights: [
    -0.342285, // propRate
    0.070182, // succMissions
    0.034791, // failMissions
    0.141614, // cleanRecord
    0.008825, // lastSuccessTeam
    -0.068297, // r1Mission
    -0.024157, // onTeamWithEvilRate
    0.424009, // pickedByEvilRate
    -0.169582, // offApproveRate
    0.771542, // onRejectRate
    0.067379, // rejectSelfTeamRate
    0.026346, // approveSelfTeamOff
    0.128215, // rejectAllyTeamRate
    -0.20374, // approveAllyTeamOff
    0.151986, // approveCleanOffRate
    -0.38706, // rejectCleanOnRate
    0.027147, // voteOutcomeAgreeRate
    -0.387495, // agreeWithAssassinRate
    -3.391321, // ledRate
    -1.539786, // ledWithSelfRate
    -0.173376, // ledWithAllyRate
    0.428314, // ledCleanCount
    0.014761, // ledApprovedRate
    0.087249, // lakedByEvilGood
    -0.425779, // lakedByEvilEvil
    -0.029785, // lakedByOtherGood
    -1.657252, // lakedByOtherEvil
    0.089753, // heldLake
    -0.297659, // lakeTargetEvil
    -0.049699, // seat1
    -0.093497, // seat2
    -0.115315, // seat3
    0.095268, // seat4
    0.236743, // seat5
    0.219664, // seat6
    -0.079047, // seat7
    -0.005588, // seat8
    -0.048372, // seat9
    -0.181448, // seat10
  ],
};
