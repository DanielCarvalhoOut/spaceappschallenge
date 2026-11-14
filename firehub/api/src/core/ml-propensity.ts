import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

export const ML_FEATURE_NAMES = [
  'rootRecurrencePct',
  'lag1HarmonizedLog',
  'spatialGradient',
  't2mMaxC',
  'vpdHpa',
  'rh2mDeficit',
  'droughtIndex',
  'ws10mMs',
] as const;

export type MlFeatureName = (typeof ML_FEATURE_NAMES)[number];

export interface MlFeatureVector {
  rootRecurrencePct: number; // 0..100 (% of years this month had active fire)
  lag1HarmonizedLog: number; // ln(1 + previous month harmonized cell-days)
  spatialGradient: number; // normalized lat/lon susceptibility factor
  t2mMaxC: number; // NASA POWER T2M_MAX (°C)
  vpdHpa: number; // Vapor Pressure Deficit (hPa)
  rh2mDeficit: number; // 100 - RH2M (%)
  droughtIndex: number; // Consecutive dry days / rain deficit score
  ws10mMs: number; // NASA POWER WS10M (m/s)
}

export interface DecisionStump {
  featureIdx: number;
  threshold: number; // on standardized feature z
  leftVal: number;
  rightVal: number;
  weight: number;
}

export interface TrainedMlPropensityModel {
  modelType: 'Hybrid-GBDT-Logistic-Ensemble-v1';
  trainedAt: string;
  trainPeriod: '2001-2019';
  testPeriod: '2020-2025';
  trainSamples: number;
  testSamples: number;
  positiveTargetDefinition: string;
  featureNames: readonly MlFeatureName[];
  scalerMean: number[];
  scalerStd: number[];
  linearWeights: number[];
  intercept: number;
  stumps: DecisionStump[];
  featureImportances: Array<{
    feature: MlFeatureName;
    labelPt: string;
    labelEn: string;
    importancePct: number;
  }>;
  metrics: {
    rocAuc: number;
    brierScore: number;
    f1Score: number;
    precision: number;
    recall: number;
    accuracy: number;
  };
}

export interface MlPropensityPrediction {
  propensityScore: number; // 0..100
  probability: number; // 0..1
  propensityClass: 'low' | 'moderate' | 'high' | 'extreme';
  modelRocAuc: number;
  contributions: Array<{
    feature: MlFeatureName;
    labelPt: string;
    labelEn: string;
    sharePct: number;
    rawValue: number;
  }>;
}

const FEATURE_LABELS: Record<MlFeatureName, { pt: string; en: string }> = {
  rootRecurrencePct: {
    pt: 'Memória de Foco Raiz (FIRMS 2000–25)',
    en: 'Root Fire Memory (FIRMS 2000–25)',
  },
  lag1HarmonizedLog: {
    pt: 'Inércia de Fogo Recente (Mês t−1)',
    en: 'Recent Fire Inertia (Month t−1)',
  },
  spatialGradient: {
    pt: 'Gradiente Espacial / Vizinhança',
    en: 'Spatial Gradient / Contagion',
  },
  t2mMaxC: {
    pt: 'Temperatura Máxima (T2M_MAX)',
    en: 'Max Temperature (T2M_MAX)',
  },
  vpdHpa: {
    pt: 'Déficit de Pressão de Vapor (VPD)',
    en: 'Vapor Pressure Deficit (VPD)',
  },
  rh2mDeficit: {
    pt: 'Secura Atmosférica (100 − RH2M)',
    en: 'Atmospheric Dryness (100 − RH2M)',
  },
  droughtIndex: {
    pt: 'Estresse de Seca (PRECTOTCORR / Dias Secos)',
    en: 'Drought Stress (PRECTOTCORR / Dry Days)',
  },
  ws10mMs: {
    pt: 'Velocidade do Vento a 10m (WS10M)',
    en: 'Wind Speed at 10m (WS10M)',
  },
};

function sigmoid(z: number): number {
  if (z > 20) return 1 / (1 + Math.exp(-20));
  if (z < -20) return 1 / (1 + Math.exp(20));
  return 1 / (1 + Math.exp(-z));
}

function toArray(f: MlFeatureVector): number[] {
  return [
    f.rootRecurrencePct,
    f.lag1HarmonizedLog,
    f.spatialGradient,
    f.t2mMaxC,
    f.vpdHpa,
    f.rh2mDeficit,
    f.droughtIndex,
    f.ws10mMs,
  ];
}

export interface TrainingRow {
  year: number;
  month: number;
  features: MlFeatureVector;
  label: 0 | 1; // 1 = critical fire outbreak in this municipality-month
}

/**
 * Computes exact ROC-AUC via trapezoidal Mann-Whitney U statistic on sorted predictions.
 */
export function computeRocAuc(probs: readonly number[], labels: readonly (0 | 1)[]): number {
  const paired = probs.map((p, i) => ({ p, y: labels[i]! }));
  paired.sort((a, b) => a.p - b.p);

  let nPos = 0;
  let nNeg = 0;
  let rankSumPos = 0;

  let i = 0;
  while (i < paired.length) {
    let j = i;
    while (j < paired.length && paired[j]!.p === paired[i]!.p) {
      j++;
    }
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (paired[k]!.y === 1) {
        nPos++;
        rankSumPos += avgRank;
      } else {
        nNeg++;
      }
    }
    i = j;
  }

  if (nPos === 0 || nNeg === 0) return 0.5;
  const uStat = rankSumPos - (nPos * (nPos + 1)) / 2;
  return uStat / (nPos * nNeg);
}

/**
 * Trains the Hybrid GBDT + L2 Logistic Regression Propensity Model on 2001–2019
 * and evaluates out-of-sample metrics on 2020–2025.
 */
export function trainPropensityModel(
  dataset: readonly TrainingRow[],
  options: { saveArtifact?: boolean } = {}
): TrainedMlPropensityModel {
  const trainRows = dataset.filter((r) => r.year >= 2001 && r.year <= 2019);
  const testRows = dataset.filter((r) => r.year >= 2020 && r.year <= 2025);

  const numFeatures = ML_FEATURE_NAMES.length;
  const nTrain = Math.max(1, trainRows.length);

  // 1. Fit Z-score standardizer on training set only (prevent data leakage)
  const scalerMean = new Array<number>(numFeatures).fill(0);
  const scalerStd = new Array<number>(numFeatures).fill(1);

  for (const row of trainRows) {
    const arr = toArray(row.features);
    for (let f = 0; f < numFeatures; f++) {
      scalerMean[f]! += arr[f]!;
    }
  }
  for (let f = 0; f < numFeatures; f++) {
    scalerMean[f]! /= nTrain;
  }

  for (const row of trainRows) {
    const arr = toArray(row.features);
    for (let f = 0; f < numFeatures; f++) {
      const diff = arr[f]! - scalerMean[f]!;
      scalerStd[f]! += diff * diff;
    }
  }
  for (let f = 0; f < numFeatures; f++) {
    scalerStd[f] = Math.max(1e-6, Math.sqrt(scalerStd[f]! / Math.max(1, nTrain - 1)));
  }

  const XTrain: number[][] = trainRows.map((r) => {
    const raw = toArray(r.features);
    return raw.map((v, f) => (v - scalerMean[f]!) / scalerStd[f]!);
  });
  const yTrain: (0 | 1)[] = trainRows.map((r) => r.label);

  // 2. Train L2-Regularized Logistic Regression via batch gradient descent with cosine learning rate
  const linearWeights = new Array<number>(numFeatures).fill(0);
  let posCount = 0;
  for (const y of yTrain) if (y === 1) posCount++;
  const baseRate = Math.min(0.95, Math.max(0.05, posCount / nTrain));
  let intercept = Math.log(baseRate / (1 - baseRate));

  const epochs = 85;
  const l2Lambda = 0.015;
  for (let ep = 0; ep < epochs; ep++) {
    const lr = 0.38 * (0.5 * (1 + Math.cos((Math.PI * ep) / epochs))) + 0.04;
    const gradW = new Array<number>(numFeatures).fill(0);
    let gradB = 0;

    for (let i = 0; i < nTrain; i++) {
      const x = XTrain[i]!;
      let z = intercept;
      for (let f = 0; f < numFeatures; f++) {
        z += linearWeights[f]! * x[f]!;
      }
      const p = sigmoid(z);
      const err = p - yTrain[i]!;
      gradB += err;
      for (let f = 0; f < numFeatures; f++) {
        gradW[f]! += err * x[f]!;
      }
    }

    intercept -= lr * (gradB / nTrain);
    for (let f = 0; f < numFeatures; f++) {
      const g = gradW[f]! / nTrain + l2Lambda * linearWeights[f]!;
      // Enforce non-negative monotonic constraint for physical hazard variables
      linearWeights[f] = Math.max(0.02, linearWeights[f]! - lr * g);
    }
  }

  // 3. Fit 16 Gradient Boosted Decision Stumps on the logistic log-odds residuals
  const logits = new Array<number>(nTrain).fill(0);
  for (let i = 0; i < nTrain; i++) {
    const x = XTrain[i]!;
    let z = intercept;
    for (let f = 0; f < numFeatures; f++) z += linearWeights[f]! * x[f]!;
    logits[i] = z;
  }

  const stumps: DecisionStump[] = [];
  const candidateThresholds = [-1.0, -0.5, 0.0, 0.5, 1.0, 1.5];
  const nStumps = 16;
  const boostLr = 0.22;

  for (let s = 0; s < nStumps; s++) {
    let bestFeature = 0;
    let bestThresh = 0;
    let bestLeft = 0;
    let bestRight = 0;
    let bestLossReduction = -Infinity;

    for (let f = 0; f < numFeatures; f++) {
      for (const th of candidateThresholds) {
        let leftResidualSum = 0;
        let leftHessSum = 1.0;
        let rightResidualSum = 0;
        let rightHessSum = 1.0;

        for (let i = 0; i < nTrain; i++) {
          const p = sigmoid(logits[i]!);
          const residual = yTrain[i]! - p;
          const hess = Math.max(0.02, p * (1 - p));
          if (XTrain[i]![f]! <= th) {
            leftResidualSum += residual;
            leftHessSum += hess;
          } else {
            rightResidualSum += residual;
            rightHessSum += hess;
          }
        }

        const leftVal = leftResidualSum / leftHessSum;
        const rightVal = rightResidualSum / rightHessSum;
        // Enforce monotonicity: higher standardized hazard feature -> higher log-odds
        if (rightVal <= leftVal) continue;

        const gain =
          (leftResidualSum * leftResidualSum) / leftHessSum +
          (rightResidualSum * rightResidualSum) / rightHessSum;
        if (gain > bestLossReduction) {
          bestLossReduction = gain;
          bestFeature = f;
          bestThresh = th;
          bestLeft = leftVal;
          bestRight = rightVal;
        }
      }
    }

    if (bestLossReduction > -Infinity) {
      const stump: DecisionStump = {
        featureIdx: bestFeature,
        threshold: bestThresh,
        leftVal: Math.round(bestLeft * 10000) / 10000,
        rightVal: Math.round(bestRight * 10000) / 10000,
        weight: boostLr,
      };
      stumps.push(stump);
      for (let i = 0; i < nTrain; i++) {
        const delta =
          XTrain[i]![stump.featureIdx]! <= stump.threshold ? stump.leftVal : stump.rightVal;
        logits[i]! += stump.weight * delta;
      }
    }
  }

  // 4. Compute Feature Importances (combining standardized linear weights + stump split gains)
  const rawImp = linearWeights.map((w) => Math.abs(w));
  for (const st of stumps) {
    rawImp[st.featureIdx]! += st.weight * Math.abs(st.rightVal - st.leftVal) * 0.85;
  }
  const impSum = rawImp.reduce((a, b) => a + b, 0) || 1;
  const featureImportances = ML_FEATURE_NAMES.map((feat, idx) => ({
    feature: feat,
    labelPt: FEATURE_LABELS[feat].pt,
    labelEn: FEATURE_LABELS[feat].en,
    importancePct: Math.round((rawImp[idx]! / impSum) * 1000) / 10,
  })).sort((a, b) => b.importancePct - a.importancePct);

  // 5. Evaluate Out-of-Sample on 2020–2025 Test Set
  const tempModel: TrainedMlPropensityModel = {
    modelType: 'Hybrid-GBDT-Logistic-Ensemble-v1',
    trainedAt: new Date().toISOString(),
    trainPeriod: '2001-2019',
    testPeriod: '2020-2025',
    trainSamples: trainRows.length,
    testSamples: testRows.length,
    positiveTargetDefinition:
      'Active fire surge: harmonized hotspot cell-days >= 20 or seasonal anomaly z >= 0.75 in municipality-month',
    featureNames: ML_FEATURE_NAMES,
    scalerMean: scalerMean.map((v) => Math.round(v * 10000) / 10000),
    scalerStd: scalerStd.map((v) => Math.round(v * 10000) / 10000),
    linearWeights: linearWeights.map((v) => Math.round(v * 10000) / 10000),
    intercept: Math.round(intercept * 10000) / 10000,
    stumps,
    featureImportances,
    metrics: {
      rocAuc: 0,
      brierScore: 0,
      f1Score: 0,
      precision: 0,
      recall: 0,
      accuracy: 0,
    },
  };

  const testProbs: number[] = [];
  const testLabels: (0 | 1)[] = [];
  let brierSum = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const row of testRows) {
    const pred = predictFirePropensity(tempModel, row.features);
    const p = pred.probability;
    const y = row.label;
    testProbs.push(p);
    testLabels.push(y);
    brierSum += (p - y) * (p - y);
    const yHat = p >= 0.5 ? 1 : 0;
    if (y === 1 && yHat === 1) tp++;
    else if (y === 0 && yHat === 1) fp++;
    else if (y === 1 && yHat === 0) fn++;
    else tn++;
  }

  const nTest = Math.max(1, testRows.length);
  const rocAuc = Math.round(computeRocAuc(testProbs, testLabels) * 1000) / 1000;
  const brierScore = Math.round((brierSum / nTest) * 10000) / 10000;
  const precision = tp + fp > 0 ? Math.round((tp / (tp + fp)) * 1000) / 1000 : 0;
  const recall = tp + fn > 0 ? Math.round((tp / (tp + fn)) * 1000) / 1000 : 0;
  const f1Score =
    precision + recall > 0
      ? Math.round(((2 * precision * recall) / (precision + recall)) * 1000) / 1000
      : 0;
  const accuracy = Math.round(((tp + tn) / nTest) * 1000) / 1000;

  tempModel.metrics = {
    rocAuc,
    brierScore,
    f1Score,
    precision,
    recall,
    accuracy,
  };

  // Persist trained model artifact in firehub/api/out/ml_propensity_model.json when requested
  if (options.saveArtifact) {
    try {
      const outFile = path.join(config.outDir, 'ml_propensity_model.json');
      fs.writeFileSync(outFile, JSON.stringify(tempModel, null, 2), 'utf8');
      logger.info(
        {
          trainSamples: tempModel.trainSamples,
          testSamples: tempModel.testSamples,
          metrics: tempModel.metrics,
        },
        'Trained ML Fire Propensity model saved to out/ml_propensity_model.json'
      );
    } catch {
      // ignore if read-only
    }
  }

  return tempModel;
}

/**
 * Predicts the ML Fire Propensity Score (0..100%) and per-feature SHAP-like attribution shares
 * for a given feature vector.
 */
export function predictFirePropensity(
  model: TrainedMlPropensityModel,
  features: MlFeatureVector
): MlPropensityPrediction {
  const raw = toArray(features);
  const zVec = raw.map((v, f) => (v - (model.scalerMean[f] ?? 0)) / (model.scalerStd[f] ?? 1));

  let logit = model.intercept;
  const featSignals = new Array<number>(ML_FEATURE_NAMES.length).fill(0);

  for (let f = 0; f < ML_FEATURE_NAMES.length; f++) {
    const linTerm = (model.linearWeights[f] ?? 0) * zVec[f]!;
    logit += linTerm;
    // Measure positive signal contribution above low-hazard baseline (z = -1.2)
    featSignals[f]! += Math.max(0.01, (model.linearWeights[f] ?? 0) * Math.max(0, zVec[f]! + 1.2));
  }

  for (const st of model.stumps) {
    const val = zVec[st.featureIdx]! <= st.threshold ? st.leftVal : st.rightVal;
    const term = st.weight * val;
    logit += term;
    if (zVec[st.featureIdx]! > st.threshold) {
      featSignals[st.featureIdx]! += st.weight * (st.rightVal - st.leftVal);
    }
  }

  const probability = Math.round(sigmoid(logit) * 10000) / 10000;
  const propensityScore = Math.round(probability * 1000) / 10;

  let propensityClass: MlPropensityPrediction['propensityClass'] = 'low';
  if (propensityScore >= 78) propensityClass = 'extreme';
  else if (propensityScore >= 55) propensityClass = 'high';
  else if (propensityScore >= 32) propensityClass = 'moderate';

  const sigSum = featSignals.reduce((a, b) => a + b, 0) || 1;
  const contributions = ML_FEATURE_NAMES.map((feat, idx) => ({
    feature: feat,
    labelPt: FEATURE_LABELS[feat].pt,
    labelEn: FEATURE_LABELS[feat].en,
    sharePct: Math.round((featSignals[idx]! / sigSum) * 1000) / 10,
    rawValue: Math.round(raw[idx]! * 100) / 100,
  })).sort((a, b) => b.sharePct - a.sharePct);

  return {
    propensityScore,
    probability,
    propensityClass,
    modelRocAuc: model.metrics.rocAuc,
    contributions,
  };
}
