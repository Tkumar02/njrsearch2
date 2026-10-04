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
 *
 * The NJR structure is effectively:
 *
 * <td>
 *   ... <span class="tableTitleBlack1">Male</span>
 * </td>
 * <td>48%</td>
 * <td>40%</td>
 *
 * where the second value is this surgeon and the third is the national
 * average.
 */
function parseDemographicRow(
  $: cheerio.CheerioAPI,
  row: Element,
  joint: 'Hip' | 'Knee',
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

  let label = cleanText(
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
 * Convert the NJR demographic wording into a stable application key.
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
    lower.includes('diagnosed with conditions other than osteoarthritis')
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

    // Avoid returning the generic page title.
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
 * Find mortality chart images.
 *
 * The NJR page contains hidden availability flags:
 *
 * #HipMortalityValue
 * #KneeMortalityValue
 *
 * These are NOT mortality percentages.
 *
 * The actual mortality result is represented by a chart. The source also
 * explicitly describes the vertical axis as a standardised mortality ratio.
 */
function extractMortality(
  $: cheerio.CheerioAPI,
  joint: 'Hip' | 'Knee',
): {
  available: boolean;
  chartUrl: string | null;
} {

  const id =
    joint === 'Hip'
      ? '#HipMortalityValue'
      : '#KneeMortalityValue';

  const flag = cleanText(
    $(id).attr('value') || ''
  );

  const available = flag !== '' && flag !== '0';

  const chartClass =
    joint === 'Hip'
      ? '.hipchart'
      : '.kneechart';

  let chartUrl =
    $(chartClass)
      .find('img')
      .first()
      .attr('src') || null;

  if (!chartUrl) {
    // Fallback: search for an image whose class/source looks like the
    // mortality chart.
    const images = $('img').toArray();

    for (const image of images) {
      const src = $(image).attr('src') || '';

      if (
        /ChartImages/i.test(src) &&
        (
          src.toLowerCase().includes(joint.toLowerCase()) ||
          src.toLowerCase().includes('mort')
        )
      ) {
        chartUrl = src;
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

  return {
    available,
    chartUrl,
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
   *
   * This is much more reliable than:
   *
   *   $el.prevAll(...)
   *
   * because the hip/knee heading is not necessarily a direct previous
   * sibling of the table row.
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
    // PROCEDURE TABLE
    // ------------------------------------------------------------

    if (
      element.tagName?.toLowerCase() !== 'table'
    ) {
      return;
    }

    const table = el;

    const tableText = cleanText(
      table.text()
    );

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

    // Ignore total rows
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
    //
    // NJR uses:
    //   hipsPrimary
    //   hipsRevision
    //   keensPrimary
    //   keensRevision
    // ----------------------------------------------------------

    const rowHtml = firstCell.html()?.toLowerCase() || '';

    let rowJoint: 'Hip' | 'Knee' | null = null;

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

    // Fallback to the operation text if the class isn't present
    if (!rowJoint) {
      const combined =
        `${operationType} ${operationSubcategory}`.toLowerCase();

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
    // Determine whether this is the 1-year or 3-year table
    // ----------------------------------------------------------

    const procedureTableHtml =
      table.toString().toLowerCase();

    let procedurePeriod: Period | null = null;

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

    // If the table itself doesn't contain the date information,
    // fall back to the period detected while walking the page.
    if (!procedurePeriod && currentPeriod !== 'All') {
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
    // Convert NJR procedure into our application key
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

    metrics.push({
      key: `${periodPrefix}-${key}`,

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
    });

    console.log(
      'NJR procedure:',
      procedurePeriod,
      rowJoint,
      operationSubcategory,
      surgeonValue,
      nationalAverage
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
            row,
            currentJoint!
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
    key: 'hip-mortality',
    label: 'Hip — 90-day mortality',
    section: 'Mortality',
    period: 'All',
    value: hipMortality.available
      ? 'Available as NJR SMR chart'
      : 'Not available',
    benchmark: '',
    type: 'mortality',
    chartUrl: hipMortality.chartUrl,
    available: hipMortality.available,
  });


  metrics.push({
    key: 'knee-mortality',
    label: 'Knee — 90-day mortality',
    section: 'Mortality',
    period: 'All',
    value: kneeMortality.available
      ? 'Available as NJR SMR chart'
      : 'Not available',
    benchmark: '',
    type: 'mortality',
    chartUrl: kneeMortality.chartUrl,
    available: kneeMortality.available,
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
       *
       * Once everything works, this could be changed to Promise.all with
       * sensible concurrency limiting.
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