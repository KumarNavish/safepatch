import katex from 'katex'

const sliderMax = 100
const copyResetDelayMs = 1400

export type SceneMode = 'geometry' | 'forces'
export type PresetId = 'normal' | 'spike' | 'incident'

export interface ControlValues {
  presetId: PresetId
  pressure: number
  tightness: number
  mode: SceneMode
}

export interface ForceBarUi {
  id: string
  label: string
  lambda: number
  color: string
  isVisible: boolean
}

export interface MathTermUi {
  id: string
  label: string
  lambdaTex: string
  vectorTex: string
  color: string
  active: boolean
}

export interface OutcomeFrameUi {
  decisionTone: 'ship' | 'hold'
  decisionTitle: string
  decisionDetail: string
  readinessText: string
  nowTitle: string
  nowBody: string
  nowReason: string
  checksText: string
  incidentText: string
  retainedText: string
  impactLine: string
  stageCaption: string
  pipelineStep: number
  pipelineLines: [string, string, string, string]
}

export interface DetailFrameUi {
  presetNote: string
  whyItems: string[]
  actionItems: string[]
  memoText: string
  mathSummaryTex: string
  mathTerms: MathTermUi[]
}

export class UIController {
  private readonly presetButtons: HTMLButtonElement[]
  private readonly modeButtons: HTMLButtonElement[]

  private readonly stageHint: HTMLElement
  private readonly stageCaption: HTMLElement

  private readonly nowTitle: HTMLElement
  private readonly nowBody: HTMLElement
  private readonly nowReason: HTMLElement

  private readonly decisionCard: HTMLElement
  private readonly decisionPill: HTMLElement
  private readonly decisionTitle: HTMLElement
  private readonly decisionDetail: HTMLElement
  private readonly readinessNote: HTMLElement

  private readonly checksValue: HTMLElement
  private readonly incidentValue: HTMLElement
  private readonly retainedValue: HTMLElement

  private readonly pipelineCard: HTMLElement
  private readonly pipelineSteps: HTMLElement[]
  private readonly pipelineLines: HTMLElement[]
  private readonly impactLine: HTMLElement

  private readonly presetNote: HTMLElement
  private readonly tightnessSlider: HTMLInputElement
  private readonly tightnessValue: HTMLElement
  private readonly replayButton: HTMLButtonElement
  private readonly forceBars: HTMLElement

  private readonly whyList: HTMLUListElement
  private readonly actionList: HTMLUListElement
  private readonly memoText: HTMLElement
  private readonly copyMemoButton: HTMLButtonElement
  private readonly exportButton: HTMLButtonElement

  private readonly equationMain: HTMLElement
  private readonly equationSub: HTMLElement
  private readonly equationTerms: HTMLElement

  private selectedPresetId: PresetId
  private selectedPressure: number
  private selectedTightness: number
  private selectedMode: SceneMode

  constructor() {
    this.presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.preset-btn'))
    this.modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-btn'))

    if (this.presetButtons.length === 0) {
      throw new Error('Missing preset buttons')
    }
    if (this.modeButtons.length === 0) {
      throw new Error('Missing mode buttons')
    }

    this.stageHint = this.getElement('stage-hint')
    this.stageCaption = this.getElement('stage-caption')

    this.nowTitle = this.getElement('now-title')
    this.nowBody = this.getElement('now-body')
    this.nowReason = this.getElement('now-reason')

    this.decisionCard = this.getElement('decision-card')
    this.decisionPill = this.getElement('decision-pill')
    this.decisionTitle = this.getElement('decision-title')
    this.decisionDetail = this.getElement('decision-detail')
    this.readinessNote = this.getElement('readiness-note')

    this.checksValue = this.getElement('checks-value')
    this.incidentValue = this.getElement('incident-value')
    this.retainedValue = this.getElement('retained-value')

    this.pipelineCard = this.getElement('pipeline-card')
    this.pipelineSteps = Array.from(document.querySelectorAll<HTMLElement>('.pipe-step'))
    this.pipelineLines = [
      this.getElement('pipe-line-0'),
      this.getElement('pipe-line-1'),
      this.getElement('pipe-line-2'),
      this.getElement('pipe-line-3'),
    ]
    this.impactLine = this.getElement('impact-line')

    this.presetNote = this.getElement('preset-note')
    this.tightnessSlider = this.getElement<HTMLInputElement>('tightness-slider')
    this.tightnessValue = this.getElement('tightness-value')
    this.replayButton = this.getElement<HTMLButtonElement>('replay-button')
    this.forceBars = this.getElement('force-bars')

    this.whyList = this.getElement<HTMLUListElement>('why-list')
    this.actionList = this.getElement<HTMLUListElement>('action-list')
    this.memoText = this.getElement('memo-text')
    this.copyMemoButton = this.getElement<HTMLButtonElement>('copy-memo-button')
    this.exportButton = this.getElement<HTMLButtonElement>('export-button')

    this.equationMain = this.getElement('equation-main')
    this.equationSub = this.getElement('equation-sub')
    this.equationTerms = this.getElement('equation-terms')

    const activePreset = this.presetButtons.find((button) => button.classList.contains('active')) ?? this.presetButtons[0]
    this.selectedPresetId = this.parsePresetId(activePreset.dataset.preset)
    this.selectedPressure = this.parsePressure(activePreset.dataset.pressure, 0.56)

    const activeMode = this.modeButtons.find((button) => button.classList.contains('active')) ?? this.modeButtons[0]
    this.selectedMode = this.parseMode(activeMode.dataset.mode)

    this.selectedTightness = this.clamp01(this.parseSliderValue(this.tightnessSlider.value, 0.62))

    this.syncPresetButtons()
    this.syncModeButtons()
    this.syncTightness()
    this.renderMathBase()
  }

  onPresetChange(callback: (controls: ControlValues) => void): void {
    for (const button of this.presetButtons) {
      button.addEventListener('click', () => {
        this.selectedPresetId = this.parsePresetId(button.dataset.preset)
        this.selectedPressure = this.parsePressure(button.dataset.pressure, this.selectedPressure)
        this.syncPresetButtons()
        callback(this.readControlValues())
      })
    }
  }

  onTightnessChange(callback: (controls: ControlValues) => void): void {
    this.tightnessSlider.addEventListener('input', () => {
      this.selectedTightness = this.clamp01(this.parseSliderValue(this.tightnessSlider.value, this.selectedTightness))
      this.syncTightness()
      callback(this.readControlValues())
    })
  }

  onModeChange(callback: (mode: SceneMode) => void): void {
    for (const button of this.modeButtons) {
      button.addEventListener('click', () => {
        const mode = this.parseMode(button.dataset.mode)
        if (mode === this.selectedMode) {
          return
        }

        this.selectedMode = mode
        this.syncModeButtons()
        callback(mode)
      })
    }
  }

  onReplay(callback: () => void): void {
    this.replayButton.addEventListener('click', callback)
  }

  onForceToggle(callback: (constraintId: string) => void): void {
    this.forceBars.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      const button = target?.closest<HTMLButtonElement>('.force-bar')
      if (!button) {
        return
      }

      const constraintId = button.dataset.constraintId
      if (!constraintId) {
        return
      }

      callback(constraintId)
    })
  }

  onCopyMemo(callback: (memoText: string) => Promise<boolean> | boolean): void {
    this.copyMemoButton.addEventListener('click', async () => {
      const copied = await callback(this.memoText.textContent ?? '')
      this.copyMemoButton.textContent = copied ? 'Copied' : 'Copy failed'
      window.setTimeout(() => {
        this.copyMemoButton.textContent = 'Copy memo'
      }, copyResetDelayMs)
    })
  }

  onExport(callback: () => void): void {
    this.exportButton.addEventListener('click', callback)
  }

  readControlValues(): ControlValues {
    return {
      presetId: this.selectedPresetId,
      pressure: this.selectedPressure,
      tightness: this.selectedTightness,
      mode: this.selectedMode,
    }
  }

  setDragActive(active: boolean): void {
    this.stageHint.textContent = active
      ? 'Dragging proposal. Safe projection and decision are updating live.'
      : 'Drag the red tip. Blue updates to the safest certifiable direction.'
  }

  renderOutcome(frame: OutcomeFrameUi): void {
    this.decisionCard.classList.toggle('ship', frame.decisionTone === 'ship')
    this.decisionCard.classList.toggle('hold', frame.decisionTone === 'hold')

    this.decisionPill.classList.toggle('ship', frame.decisionTone === 'ship')
    this.decisionPill.classList.toggle('hold', frame.decisionTone === 'hold')
    this.decisionPill.textContent = frame.decisionTone === 'ship' ? 'SHIP' : 'HOLD'

    this.decisionTitle.textContent = frame.decisionTitle
    this.decisionDetail.textContent = frame.decisionDetail
    this.readinessNote.textContent = frame.readinessText

    this.nowTitle.textContent = frame.nowTitle
    this.nowBody.textContent = frame.nowBody
    this.nowReason.textContent = frame.nowReason

    this.checksValue.textContent = frame.checksText
    this.incidentValue.textContent = frame.incidentText
    this.retainedValue.textContent = frame.retainedText

    this.impactLine.textContent = frame.impactLine
    this.stageCaption.textContent = frame.stageCaption

    this.pipelineCard.style.setProperty('--pipeline-progress', `${Math.round(Math.min(Math.max(frame.pipelineStep / 3, 0), 1) * 100)}%`)

    for (const node of this.pipelineSteps) {
      const step = Number.parseInt(node.dataset.step ?? '', 10)
      node.classList.toggle('active', step === frame.pipelineStep)
      node.classList.toggle('completed', step < frame.pipelineStep)
    }

    frame.pipelineLines.forEach((line, index) => {
      const node = this.pipelineLines[index]
      if (node) {
        node.textContent = line
      }
    })
  }

  renderDetails(frame: DetailFrameUi): void {
    this.presetNote.textContent = frame.presetNote
    this.memoText.textContent = frame.memoText

    this.renderList(this.whyList, frame.whyItems, 'No rationale yet.')
    this.renderList(this.actionList, frame.actionItems, 'No action generated yet.')

    this.renderTex(this.equationSub, frame.mathSummaryTex, true)
    this.renderMathTerms(frame.mathTerms)
  }

  renderForceBars(items: ForceBarUi[]): void {
    if (items.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'force-empty'
      empty.textContent = 'No active correction pressure.'
      this.forceBars.replaceChildren(empty)
      return
    }

    const maxLambda = Math.max(...items.map((item) => item.lambda), 1e-6)

    const nodes = items.map((item) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `force-bar${item.isVisible ? ' active' : ''}`
      button.dataset.constraintId = item.id
      button.style.setProperty('--bar-color', item.color)

      const head = document.createElement('div')
      head.className = 'force-head'

      const label = document.createElement('p')
      label.className = 'force-label'
      label.textContent = item.label

      const value = document.createElement('p')
      value.className = 'force-value'
      value.textContent = `λ ${item.lambda.toFixed(3)}`

      head.append(label, value)

      const meter = document.createElement('div')
      meter.className = 'force-meter'

      const fill = document.createElement('span')
      fill.className = 'force-meter-fill'
      fill.style.width = `${Math.max(10, (item.lambda / maxLambda) * 100).toFixed(1)}%`

      meter.append(fill)
      button.append(head, meter)
      return button
    })

    this.forceBars.replaceChildren(...nodes)
  }

  toggleForcePanel(show: boolean): void {
    this.forceBars.classList.toggle('hidden', !show)
  }

  private renderMathBase(): void {
    this.renderTex(this.equationMain, String.raw`\Delta^\star = \Delta_0 + \sum_{k\in\mathcal{A}}\left(-\eta\,\lambda_k\,n_k\right)`, true)
    this.renderTex(this.equationSub, String.raw`\text{Interact to populate active correction terms.}`, true)
  }

  private renderMathTerms(terms: MathTermUi[]): void {
    if (terms.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'math-note'
      empty.textContent = 'No active policy terms. Proposal is already safe.'
      this.equationTerms.replaceChildren(empty)
      return
    }

    const rows = terms.map((term) => {
      const row = document.createElement('article')
      row.className = `math-term${term.active ? '' : ' inactive'}`
      row.style.borderLeftColor = term.color

      const label = document.createElement('p')
      label.className = 'math-label'
      label.textContent = term.label

      const lambda = document.createElement('p')
      lambda.className = 'math-line'
      this.renderTex(lambda, term.lambdaTex, false)

      const vector = document.createElement('p')
      vector.className = 'math-line'
      this.renderTex(vector, term.vectorTex, false)

      row.append(label, lambda, vector)
      return row
    })

    this.equationTerms.replaceChildren(...rows)
  }

  private renderList(target: HTMLUListElement, items: string[], fallback: string): void {
    const values = items.length > 0 ? items.slice(0, 4) : [fallback]
    const nodes = values.map((value) => {
      const li = document.createElement('li')
      li.textContent = value
      return li
    })
    target.replaceChildren(...nodes)
  }

  private renderTex(target: HTMLElement, tex: string, displayMode: boolean): void {
    try {
      target.innerHTML = katex.renderToString(tex, {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        output: 'html',
      })
    } catch {
      target.textContent = tex
    }
  }

  private syncPresetButtons(): void {
    this.presetButtons.forEach((button) => {
      const isActive = this.parsePresetId(button.dataset.preset) === this.selectedPresetId
      button.classList.toggle('active', isActive)
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false')
    })
  }

  private syncModeButtons(): void {
    this.modeButtons.forEach((button) => {
      const isActive = this.parseMode(button.dataset.mode) === this.selectedMode
      button.classList.toggle('active', isActive)
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false')
    })

    this.toggleForcePanel(this.selectedMode === 'forces')
  }

  private syncTightness(): void {
    const percentValue = Math.round(this.selectedTightness * 100)
    this.tightnessSlider.value = percentValue.toString()
    this.tightnessValue.textContent = `${percentValue}%`
  }

  private parsePresetId(value: string | undefined): PresetId {
    if (value === 'normal' || value === 'incident') {
      return value
    }
    return 'spike'
  }

  private parseMode(value: string | undefined): SceneMode {
    if (value === 'forces') {
      return 'forces'
    }
    return 'geometry'
  }

  private parsePressure(value: string | undefined, fallback: number): number {
    const parsed = Number.parseFloat(value ?? '')
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private parseSliderValue(raw: string, fallback: number): number {
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) {
      return fallback
    }
    return parsed / sliderMax
  }

  private clamp01(value: number): number {
    return Math.min(Math.max(value, 0), 1)
  }

  private getElement<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = document.getElementById(id)
    if (!node) {
      throw new Error(`Missing #${id}`)
    }
    return node as T
  }
}
