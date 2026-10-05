import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

export interface SurgeonMetric {
  key: string;
  label: string;
  section: string;
  period?: '1-Year' | '3-Year' | 'All';
  value: string;
  benchmark: string;
  type: 'volume' | 'percentage' | 'mortality';
  chartUrl?: string | null;
  available?: boolean;
  smr?: number | null;

smrStatus?:
  | 'Below average'
  | 'At average'
  | 'Above average'
  | 'Not available';

warning?: boolean;
}

export interface SurgeonProfile {
  name: string;
  gmc: string;
  metrics: SurgeonMetric[];
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
})
export class App {
  private readonly http = inject(HttpClient);

  gmcInput = '';

  profiles: SurgeonProfile[] = [];

  loading = false;
  error = '';

  isWarning(
  profile: SurgeonProfile,
  key: string,
): boolean {
  const metric =
    profile.metrics.find(
      m => m.key === key
    );

  return metric?.warning === true;
}


mortalityStatus(
  profile: SurgeonProfile,
  key: string,
): string {
  const metric =
    profile.metrics.find(
      m => m.key === key
    );

  return metric?.smrStatus || '';
}

  /**
   * The rows shown in the comparison table.
   *
   * We deliberately keep these as fixed rows so that missing data for one
   * surgeon does not cause the columns to move around.
   */
  readonly metricRows = [
    // 1 year
    {
      key: '1y-hip-total',
      label: 'Hip — Total hip replacement',
      section: 'Surgical volume',
      period: '1-Year',
    },
    {
      key: '1y-hip-hemi',
      label: 'Hip — Hemiarthroplasty',
      section: 'Surgical volume',
      period: '1-Year',
    },
    {
      key: '1y-hip-revision',
      label: 'Hip — Revision',
      section: 'Surgical volume',
      period: '1-Year',
    },
    {
      key: '1y-knee-total',
      label: 'Knee — Total knee replacement',
      section: 'Surgical volume',
      period: '1-Year',
    },
    {
      key: '1y-knee-unicondylar',
      label: 'Knee — Unicondylar replacement',
      section: 'Surgical volume',
      period: '1-Year',
    },
    {
      key: '1y-knee-patellofemoral',
      label: 'Knee — Patello-Femoral replacement',
      section: 'Surgical volume',
      period: '1-Year',
    },
    {
      key: '1y-knee-revision',
      label: 'Knee — Revision',
      section: 'Surgical volume',
      period: '1-Year',
    },

    // 3 year
    {
      key: '3y-hip-total',
      label: 'Hip — Total hip replacement',
      section: 'Surgical volume',
      period: '3-Year',
    },
    {
      key: '3y-hip-hemi',
      label: 'Hip — Hemiarthroplasty',
      section: 'Surgical volume',
      period: '3-Year',
    },
    {
      key: '3y-hip-revision',
      label: 'Hip — Revision',
      section: 'Surgical volume',
      period: '3-Year',
    },
    {
      key: '3y-knee-total',
      label: 'Knee — Total knee replacement',
      section: 'Surgical volume',
      period: '3-Year',
    },
    {
      key: '3y-knee-unicondylar',
      label: 'Knee — Unicondylar replacement',
      section: 'Surgical volume',
      period: '3-Year',
    },
    {
      key: '3y-knee-patellofemoral',
      label: 'Knee — Patello-Femoral replacement',
      section: 'Surgical volume',
      period: '3-Year',
    },
    {
      key: '3y-knee-revision',
      label: 'Knee — Revision',
      section: 'Surgical volume',
      period: '3-Year',
    },

    // Patient characteristics
    {
      key: 'hip-male',
      label: 'Hip — Male',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'hip-under60',
      label: 'Hip — Under 60 years',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'hip-asa3',
      label: 'Hip — ASA 3+',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'hip-nhs',
      label: 'Hip — NHS-funded',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'hip-otheroa',
      label: 'Hip — Diagnosis other than osteoarthritis',
      section: 'Patient characteristics',
      period: 'All',
    },

    {
      key: 'knee-male',
      label: 'Knee — Male',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'knee-under60',
      label: 'Knee — Under 60 years',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'knee-asa3',
      label: 'Knee — ASA 3+',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'knee-nhs',
      label: 'Knee — NHS-funded',
      section: 'Patient characteristics',
      period: 'All',
    },
    {
      key: 'knee-otheroa',
      label: 'Knee — Diagnosis other than osteoarthritis',
      section: 'Patient characteristics',
      period: 'All',
    },

    // Mortality
    {
      key: 'hip-mortality',
      label: 'Hip — 90-day mortality',
      section: 'Mortality',
      period: 'All',
    },
    {
      key: 'knee-mortality',
      label: 'Knee — 90-day mortality',
      section: 'Mortality',
      period: 'All',
    },
  ];

  get hasProfiles(): boolean {
    return this.profiles.length > 0;
  }

  addGmc(): void {
    // Mainly useful if you want to turn the input into individual chips later.
    // For now the input accepts comma, space or newline separated GMC numbers.
  }

  clear(): void {
    this.gmcInput = '';
    this.profiles = [];
    this.error = '';
  }

  loadSurgeons(): void {
    this.error = '';

    const gmcCodes = this.gmcInput
      .split(/[\s,;]+/)
      .map(x => x.trim())
      .filter(Boolean);

    const uniqueCodes = [...new Set(gmcCodes)];

    if (!uniqueCodes.length) {
      this.error = 'Enter at least one GMC number.';
      return;
    }

    this.loading = true;

    this.http
      .post<{ success: boolean; profiles: SurgeonProfile[]; error?: string }>(
        '/api/surgeon',
        { gmcCodes: uniqueCodes }
      )
      .subscribe({
        next: response => {
          this.profiles = response.profiles ?? [];

          if (!this.profiles.length) {
            this.error = response.error || 'No surgeon profiles were returned.';
          }

          this.loading = false;
        },
        error: err => {
          console.error(err);
          this.error =
            err?.error?.error ||
            err?.message ||
            'There was a problem loading the surgeon profiles.';
          this.loading = false;
        },
      });
  }

  metricFor(profile: SurgeonProfile, key: string): SurgeonMetric | undefined {
    return profile.metrics.find(metric => metric.key === key);
  }

  displayValue(profile: SurgeonProfile, key: string): string {
  const metric = this.metricFor(profile, key);

  if (!metric) {
    return '—';
  }

  if (metric.type === 'mortality') {
    if (!metric.available) {
      return 'Not available';
    }

    if (metric.smr == null) {
      return 'SMR not available';
    }

    return metric.smr.toFixed(3);
  }

  return metric.value || '—';
}

displayBenchmark(profile: SurgeonProfile, key: string): string {
  const metric = this.metricFor(profile, key);

  if (!metric) {
    return '';
  }

  if (metric.type === 'mortality') {
    return 'National average: SMR 1.000';
  }

  if (!metric.benchmark) {
    return '';
  }

  return `National avg: ${metric.benchmark}`;
}

  mortalityChart(profile: SurgeonProfile, key: string): string | null {
    return this.metricFor(profile, key)?.chartUrl || null;
  }

  trackProfile(_: number, profile: SurgeonProfile): string {
    return profile.gmc;
  }

  trackMetric(_: number, row: any): string {
    return row.key;
  }

  isSmrAboveOne(profile: any, metricKey: string): boolean {
  const valStr = this.displayValue(profile, metricKey);
  const parsed = parseFloat(valStr);
  return !isNaN(parsed) && parsed > 1.0;
}

isCellInWarningState(profile: any, row: any): boolean {
  const valStr = this.displayValue(profile, row.key);
  const benchStr = this.displayBenchmark(profile, row.key);
  
  const val = parseFloat(valStr);
  const bench = parseFloat(benchStr);

  // If numbers can't be parsed, no warning
  if (isNaN(val)) return false;

  // Rule 1: Mortality / Revision rates -> Red if ABOVE national average (or > 1 where applicable)
  if (row.section === 'Mortality' || row.key.toLowerCase().includes('revision')) {
    // If benchmark exists, compare to it. Otherwise fallback to > 1.0 for SMR.
    if (!isNaN(bench)) {
      return val > bench;
    }
    return val > 1.0;
  }

  // Rule 2: Total Hip Replacement / Total Knee Replacement -> Red if BELOW national average
  const keyLower = row.key.toLowerCase();
  if (keyLower.includes('hip') || keyLower.includes('knee') || keyLower.includes('replacement')) {
    if (!isNaN(bench)) {
      return val < bench;
    }
  }

  return false;
}

}