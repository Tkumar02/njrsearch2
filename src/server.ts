import type { Element } from 'domhandler';

import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';

import express from 'express';
import { join } from 'node:path';
import * as cheerio from 'cheerio';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

app.use(express.json());

type Period = '1-Year' | '3-Year' | 'All';

type MetricType =
  | 'volume'
  | 'percentage'
  | 'mortality';

type SmrStatus =
  | 'Below average'
  | 'At average'
  | 'Above average'
  | 'Not available';

interface SurgeonMetric {
  key: string;
  label: string;
  section: string;
  period: Period;
  value: string;
  benchmark: string;
  type: MetricType;

  chartUrl?: string | null;
  available?: boolean;

  // Mortality
  smr?: number | null;
  smrStatus?: SmrStatus;

  // Used by Angular to colour the cell red.
  warning?: boolean;
}

interface SurgeonProfile {
  name: string;
  gmc: string;
  metrics: SurgeonMetric[];
}


/**
 * Clean HTML-ish whitespace without destroying values such as:
 *
 * "Fewer Than 5"
 * "295+"
 * "100%"
 */
function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * NJR uses "Fewer Than 5" to suppress small numbers.
 *
 * Do NOT convert this to 0.
 */
function cleanValue(value: string): string {
  const text = cleanText(value);

  if (!text) {
    return '';
  }

  if (/fewer\s+than\s+5/i.test(text)) {
    return 'Fewer Than 5';
  }

  return text;
}


/**
 * Convert a displayed NJR number into a numeric value only when
 * we can safely compare it.
 *
 * Returns null for:
 *   Fewer Than 5
 *   295+
 *   blank / non-numeric values
 *
 * This is deliberate: we do not want to falsely claim that a
 * suppressed or threshold value is above/below the benchmark.
 */
function comparableNumber(value: string): number | null {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  if (/fewer\s+than\s+5/i.test(text)) {
    return null;
  }

  if (text.includes('+')) {
    return null;
  }

  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);

  if (!match) {
    return null;
  }

  const number = Number(match[0]);

  return Number.isFinite(number)
    ? number
    : null;
}


/**
 * Normalise procedure names into stable keys used by Angular.
 */
function procedureKey(
  joint: 'Hip' | 'Knee',
  operationType: string,
  operationSubcategory: string,
): string | null {

  const type = operationType.toLowerCase().trim();
  const sub = operationSubcategory.toLowerCase().trim();

  if (joint === 'Hip') {

    if (
      sub.includes('total hip replacement') ||
      sub.includes('total hip')
    ) {
      return 'hip-total';
    }

    if (
      sub.includes('hemiarthroplasty') ||
      sub.includes('hemi arthroplasty')
    ) {
      return 'hip-hemi';
    }

    if (
      type.includes('revision') ||
      sub.includes('revision')
    ) {
      return 'hip-revision';
    }
  }

  if (joint === 'Knee') {

    if (
      sub.includes('total knee replacement') ||
      sub === 'total knee'
    ) {
      return 'knee-total';
    }

    if (
      sub.includes('unicondylar')
    ) {
      return 'knee-unicondylar';
    }

    if (
      sub.includes('patello-femoral') ||
      sub.includes('patello femoral') ||
      sub.includes('patellofemoral')
    ) {
      return 'knee-patellofemoral';
    }

    if (
      type.includes('revision') ||
      sub.includes('revision')
    ) {
      return 'knee-revision';
    }
  }

  return null;
}


/**
 * Extract a demographic row.
 */
function parseDemographicRow(
  $: cheerio.CheerioAPI,
  row: Element,
): {
  label: string;
  value: string;
  benchmark: string;
} | null {

  const cells = $(row).find('td');

  if (cells.length < 3) {
    return null;
  }

  const labelElement = $(cells.get(0)).find(
    '.tableTitleBlack1'
  );

  const label = cleanText(
    labelElement.length
      ? labelElement.text()
      : $(cells.get(0)).text()
  );

  const value = cleanValue(
    $(cells.get(1)).text()
  );

  const benchmark = cleanValue(
    $(cells.get(2)).text()
  );

  if (!label || !value) {
    return null;
  }

  return {
    label,
    value,
    benchmark,
  };
}


/**
 * Convert NJR demographic wording into a stable application key.
 */
function demographicKey(
  joint: 'Hip' | 'Knee',
  label: string,
): string | null {

  const lower = label.toLowerCase();

  if (lower === 'male') {
    return `${joint.toLowerCase()}-male`;
  }

  if (lower.includes('under 60')) {
    return `${joint.toLowerCase()}-under60`;
  }

  if (lower.includes('asa 3+')) {
    return `${joint.toLowerCase()}-asa3`;
  }

  if (lower.includes('nhs-funded')) {
    return `${joint.toLowerCase()}-nhs`;
  }

  if (
    lower.includes(
      'diagnosed with conditions other than osteoarthritis'
    )
  ) {
    return `${joint.toLowerCase()}-otheroa`;
  }

  return null;
}


/**
 * Find the first useful surgeon name on the page.
 */
function extractSurgeonName(
  $: cheerio.CheerioAPI,
  gmc: string,
): string {

  const candidates = [
    $('.profile_title').first().text(),
    $('.surgeon-name').first().text(),
    $('.profileTitle').first().text(),
    $('h1').first().text(),
    $('title').first().text(),
  ];

  for (const candidate of candidates) {

    const text = cleanText(candidate);

    if (!text) {
      continue;
    }

    if (
      /surgeon profile/i.test(text) &&
      /njr/i.test(text)
    ) {
      continue;
    }

    return text;
  }

  return `Surgeon ${gmc}`;
}


/**
 * Extract the SMR from the NJR mortality chart image ID.
 *
 * Example:
 *
 *   0.401_0.71399998664856_7074306K.png
 *
 * We currently interpret:
 *
 *   0.401                  = horizontal/chart value
 *   0.71399998664856      = vertical/SMR value
 *
 * The second value is therefore the value used for mortality
 * comparison against the national-average SMR of 1.0.
 */
function extractSmrFromImageId(
  imageId: string,
): number | null {

  const filename = imageId
    .split('/')
    .pop()
    ?.trim() || '';

  const match = filename.match(
    /^(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)(?:_[^_]+)?\.(?:png|jpg|jpeg)$/i
  );

  if (!match) {
    return null;
  }

  const smr = Number(match[2]);

  if (!Number.isFinite(smr)) {
    return null;
  }

  return smr;
}


/**
 * Convert SMR into a human-readable comparison.
 */
function smrStatus(
  smr: number | null,
): SmrStatus {

  if (smr === null) {
    return 'Not available';
  }

  if (smr > 1) {
    return 'Above average';
  }

  if (smr < 1) {
    return 'Below average';
  }

  return 'At average';
}


/**
 * Find mortality chart and SMR.
 */
function extractMortality(
  $: cheerio.CheerioAPI,
  joint: 'Hip' | 'Knee',
): {
  available: boolean;
  chartUrl: string | null;
  smr: number | null;
  smrStatus: SmrStatus;
} {
  const inputId =
    joint === 'Hip'
      ? '#HipMortalityValue'
      : '#KneeMortalityValue';

  const inputElement = $(inputId);
  const flag = cleanText(inputElement.attr('value') || '');

  const available = flag !== '' && flag !== '0';

  // Find the closest container box and look for the chart image inside it
  const container = inputElement.closest('.toggle_container, .box-rounded, div');
  const imgElement = container.find('img.csp-s67, img').first();

  let chartUrl = imgElement.attr('src') || null;
  let imageId = imgElement.attr('id') || '';

  /*
   * Fallback: if not found via container, search all images for ChartImages
   */
  if (!chartUrl || !imageId) {
    const images = $('img').toArray();

    for (const image of images) {
      const src = $(image).attr('src') || '';
      const id = $(image).attr('id') || '';

      if (
        /ChartImages/i.test(src) &&
        (
          src.toLowerCase().includes(joint.toLowerCase()) ||
          src.toLowerCase().includes('mort') ||
          id.includes('H.png') ||
          id.includes('K.png')
        )
      ) {
        chartUrl = src;
        imageId = id;
        break;
      }
    }
  }

  if (
    chartUrl &&
    chartUrl.startsWith('/')
  ) {
    chartUrl =
      `https://surgeonprofile.njrcentre.org.uk${chartUrl}`;
  }

  const smr =
    available
      ? extractSmrFromImageId(imageId)
      : null;

  return {
    available,
    chartUrl,
    smr,
    smrStatus: smrStatus(smr),
  };
}


/**
 * Parse one NJR surgeon profile.
 */
function parseSurgeonPage(
  html: string,
  gmc: string,
): SurgeonProfile {

  const $ = cheerio.load(html);

  const name = extractSurgeonName($, gmc);

  const metrics: SurgeonMetric[] = [];

  let currentJoint: 'Hip' | 'Knee' | null = null;

  let currentPeriod: Period = 'All';


  /**
   * Walk the document in source order.
   */
  $('body *').each((_, element) => {

    const el = $(element);

    const classes = (
      el.attr('class') || ''
    ).toLowerCase();

    const text = cleanText(
      el.clone()
        .children()
        .remove()
        .end()
        .text()
    );


    // ------------------------------------------------------------
    // JOINT SECTION
    // ------------------------------------------------------------

    if (
      classes.includes('trigger-hips') ||
      classes.includes('trigger-hipssubtab')
    ) {
      currentJoint = 'Hip';
    }

    if (
      classes.includes('trigger-knees') ||
      classes.includes('trigger-kneessubtab')
    ) {
      currentJoint = 'Knee';
    }


    // ------------------------------------------------------------
    // TIME PERIOD
    // ------------------------------------------------------------

    if (
      text.includes('12-MONTH PRACTICE PROFILE') ||
      text.includes('(1 YEAR)')
    ) {
      currentPeriod = '1-Year';
    }

    if (
      text.includes('36-MONTH PRACTICE PROFILE') ||
      text.includes('(3 YEAR)')
    ) {
      currentPeriod = '3-Year';
    }


    // ------------------------------------------------------------
    // ONLY PROCESS TABLES
    // ------------------------------------------------------------

    if (
      element.tagName?.toLowerCase() !== 'table'
    ) {
      return;
    }

    const table = el;

    const headers = table
      .find('thead th')
      .map((__, th) => cleanText($(th).text()))
      .get();

    const isProcedureTable =
      headers.some(
        header =>
          /procedures recorded for this surgeon/i.test(header)
      );

    const isDemographicTable =
      headers.some(
        header =>
          /percentage of patients who were/i.test(header)
      );


    // ------------------------------------------------------------
    // PROCEDURES
    // ------------------------------------------------------------

    if (isProcedureTable) {

      table.find('tbody tr').each((__, row) => {

        const rowEl = $(row);

        const cells = rowEl.find('td');

        if (cells.length < 4) {
          return;
        }

        const firstCell = $(cells.get(0));

        const operationType = cleanText(
          firstCell.text()
        );

        const operationSubcategory = cleanText(
          $(cells.get(1)).text()
        );

        const surgeonValue = cleanValue(
          $(cells.get(2)).text()
        );

        const nationalAverage = cleanValue(
          $(cells.get(3)).text()
        );


        // ----------------------------------------------------------
        // Ignore total rows
        // ----------------------------------------------------------

        if (
          !operationSubcategory ||
          operationSubcategory === '-' ||
          /^total$/i.test(operationType) ||
          /^total$/i.test(operationSubcategory)
        ) {
          return;
        }


        // ----------------------------------------------------------
        // Determine joint FROM THE ROW
        // ----------------------------------------------------------

        const rowHtml =
          firstCell.html()?.toLowerCase() || '';

        let rowJoint:
          | 'Hip'
          | 'Knee'
          | null = null;

        if (
          rowHtml.includes('hipsprimary') ||
          rowHtml.includes('hipsrevision')
        ) {
          rowJoint = 'Hip';
        }

        if (
          rowHtml.includes('keensprimary') ||
          rowHtml.includes('keensrevision')
        ) {
          rowJoint = 'Knee';
        }


        // Fallback to operation text
        if (!rowJoint) {

          const combined =
            `${operationType} ${operationSubcategory}`
              .toLowerCase();

          if (combined.includes('hip')) {
            rowJoint = 'Hip';
          } else if (combined.includes('knee')) {
            rowJoint = 'Knee';
          }
        }


        if (!rowJoint) {

          console.warn(
            'Could not determine joint for procedure row:',
            operationType,
            operationSubcategory
          );

          return;
        }


        // ----------------------------------------------------------
        // Determine period
        // ----------------------------------------------------------

        const procedureTableHtml =
          table.toString().toLowerCase();

        let procedurePeriod:
          | Period
          | null = null;

        if (
          procedureTableHtml.includes(
            '1 april 2025 to 31 march 2026'
          )
        ) {
          procedurePeriod = '1-Year';
        }

        if (
          procedureTableHtml.includes(
            '1 april 2023 to 31 march 2026'
          )
        ) {
          procedurePeriod = '3-Year';
        }

        if (
          !procedurePeriod &&
          currentPeriod !== 'All'
        ) {
          procedurePeriod = currentPeriod;
        }

        if (!procedurePeriod) {

          console.warn(
            'Could not determine procedure period:',
            operationType,
            operationSubcategory
          );

          return;
        }


        // ----------------------------------------------------------
        // Convert procedure to application key
        // ----------------------------------------------------------

        const key = procedureKey(
          rowJoint,
          operationType,
          operationSubcategory
        );

        if (!key) {

          console.log(
            'Ignoring NJR procedure:',
            rowJoint,
            operationType,
            operationSubcategory
          );

          return;
        }


        const periodPrefix =
          procedurePeriod === '1-Year'
            ? '1y'
            : '3y';


        // ----------------------------------------------------------
        // Determine whether this is a revision
        // ----------------------------------------------------------

        const isRevision =
          operationType.toLowerCase().includes('revision') ||
          operationSubcategory.toLowerCase().includes('revision');


        // ----------------------------------------------------------
        // Compare numerical procedure values
        // ----------------------------------------------------------

        const surgeonNumber =
          comparableNumber(surgeonValue);

        const nationalNumber =
          comparableNumber(nationalAverage);

        let warning = false;

        /*
         * Revision:
         *
         * Red when surgeon's revision count is ABOVE
         * the NJR national average.
         */
        if (
          isRevision &&
          surgeonNumber !== null &&
          nationalNumber !== null &&
          surgeonNumber > nationalNumber
        ) {
          warning = true;
        }

        /*
         * Non-revision procedure:
         *
         * Red when surgeon's procedure count is BELOW
         * the NJR national average.
         *
         * We only do this when both values are genuine
         * numeric counts.
         */
        if (
          !isRevision &&
          surgeonNumber !== null &&
          nationalNumber !== null &&
          surgeonNumber !== 0 &&
          surgeonNumber < nationalNumber
        ) {
          warning = true;
        }


        metrics.push({

          key:
            `${periodPrefix}-${key}`,

          label:
            `${rowJoint} — ${operationSubcategory}`,

          section:
            'Surgical volume',

          period:
            procedurePeriod,

          value:
            surgeonValue,

          benchmark:
            nationalAverage,

          type:
            'volume',

          warning,
        });


        console.log(
          'NJR procedure:',
          procedurePeriod,
          rowJoint,
          operationSubcategory,
          surgeonValue,
          nationalAverage,
          warning
            ? '⚠ WARNING'
            : ''
        );

      });

      return;
    }


    // ------------------------------------------------------------
    // DEMOGRAPHICS
    // ------------------------------------------------------------

    if (
      isDemographicTable &&
      currentJoint
    ) {

      table.find('tbody tr').each((__, row) => {

        const parsed =
          parseDemographicRow(
            $,
            row
          );

        if (!parsed) {
          return;
        }

        const key =
          demographicKey(
            currentJoint!,
            parsed.label
          );

        if (!key) {
          return;
        }

        metrics.push({

          key,

          label:
            `${currentJoint} — ${parsed.label}`,

          section:
            'Patient characteristics',

          period:
            'All',

          value:
            parsed.value,

          benchmark:
            parsed.benchmark,

          type:
            'percentage',
        });

      });

      return;
    }

  });


  // ------------------------------------------------------------
  // MORTALITY
  // ------------------------------------------------------------

  const hipMortality =
    extractMortality(
      $,
      'Hip'
    );

  const kneeMortality =
    extractMortality(
      $,
      'Knee'
    );


  metrics.push({

    key:
      'hip-mortality',

    label:
      'Hip — 90-day mortality',

    section:
      'Mortality',

    period:
      'All',

    value:
      hipMortality.available &&
      hipMortality.smr !== null
        ? hipMortality.smr.toFixed(3)
        : 'Not available',

    benchmark:
      '1.0 = national average',

    type:
      'mortality',

    chartUrl:
      hipMortality.chartUrl,

    available:
      hipMortality.available,

    smr:
      hipMortality.smr,

    smrStatus:
      hipMortality.smrStatus,

    warning:
      hipMortality.smr !== null &&
      hipMortality.smr > 1,
  });


  metrics.push({

    key:
      'knee-mortality',

    label:
      'Knee — 90-day mortality',

    section:
      'Mortality',

    period:
      'All',

    value:
      kneeMortality.available &&
      kneeMortality.smr !== null
        ? kneeMortality.smr.toFixed(3)
        : 'Not available',

    benchmark:
      '1.0 = national average',

    type:
      'mortality',

    chartUrl:
      kneeMortality.chartUrl,

    available:
      kneeMortality.available,

    smr:
      kneeMortality.smr,

    smrStatus:
      kneeMortality.smrStatus,

    warning:
      kneeMortality.smr !== null &&
      kneeMortality.smr > 1,
  });


  return {
    name,
    gmc,
    metrics,
  };
}


/**
 * NJR REGISTRY SCRAPER ENDPOINT
 */
app.post(
  '/api/surgeon',
  async (
    req: express.Request,
    res: express.Response
  ) => {

    console.log(
      '🎯 /api/surgeon:',
      req.body
    );

    try {

      const { gmcCodes } = req.body;


      if (
        !Array.isArray(gmcCodes) ||
        gmcCodes.length === 0
      ) {

        return res.status(400).json({
          success: false,
          error:
            'An array of GMC Numbers is required.',
        });
      }


      const cleanedCodes = [
        ...new Set(
          gmcCodes
            .map((code: unknown) =>
              String(code).trim()
            )
            .filter(Boolean)
        ),
      ];


      if (!cleanedCodes.length) {

        return res.status(400).json({
          success: false,
          error:
            'No valid GMC Numbers were supplied.',
        });
      }


      const profiles: SurgeonProfile[] = [];


      /**
       * Sequential requests are intentional for this first version.
       */
      for (const gmcCode of cleanedCodes) {

        const targetUrl =
          `https://surgeonprofile.njrcentre.org.uk/SurgeonProfile?gmccode=${encodeURIComponent(gmcCode)}`;


        try {

          console.log(
            `Fetching GMC ${gmcCode}`
          );


          const webResponse =
            await fetch(
              targetUrl,
              {
                headers: {

                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',

                  'Accept':
                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                  'Accept-Language':
                    'en-GB,en;q=0.9',
                },
              }
            );


          if (!webResponse.ok) {

            console.warn(
              `GMC ${gmcCode}: HTTP ${webResponse.status}`
            );

            continue;
          }


          const html =
            await webResponse.text();


          if (
            !html ||
            html.length < 1000
          ) {

            console.warn(
              `GMC ${gmcCode}: unexpected HTML response`
            );

            continue;
          }


          const profile =
            parseSurgeonPage(
              html,
              gmcCode
            );


          profiles.push(
            profile
          );


        } catch (error: any) {

          console.error(
            `Error parsing GMC ${gmcCode}:`,
            error?.message || error
          );

        }

      }


      return res.json({
        success: true,
        profiles,
      });


    } catch (error: any) {

      console.error(
        'API error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          'Unexpected server error',
      });
    }
  }
);


/**
 * Angular static files
 */
app.use(
  express.static(
    browserDistFolder,
    {
      maxAge: '1y',
      index: false,
      redirect: false,
    }
  )
);


/**
 * Angular SSR fallback
 */
app.use(
  (
    req,
    res,
    next
  ) => {

    angularApp
      .handle(req)
      .then(
        response =>
          response
            ? writeResponseToNodeResponse(
                response,
                res
              )
            : next()
      )
      .catch(next);

  }
);


if (
  isMainModule(import.meta.url) ||
  process.env['pm_id']
) {

  const port =
    process.env['PORT'] || 4000;

  app.listen(
    port,
    error => {

      if (error) {
        throw error;
      }

      console.log(
        `Node Express server listening on http://localhost:${port}`
      );

    }
  );
}


export const reqHandler =
  createNodeRequestHandler(app);