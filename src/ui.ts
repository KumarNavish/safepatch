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
  checksText: string
  queueText: string
  retainedText: string
  readinessText: string
  stageCaption: string
  guideStep: string
  guideTitle: string
  guideResult: string
  storyProgress: number
  storyStep: number
  storyTitle: string
  storyCause: string
  storyEffect: string
  valueTitle: string
  valueMetric: string
  valueNote: string
  impactCorrectionText: string
  impactRiskText: string
  impactBlockerText: string
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
  private readonly sidebar: HTMLElement
  private readonly guideStep: HTMLElement
  private readonly guideTitle: HTMLElement
  private readonly guideResult: HTMLElement

  private readonly presetNote: HTMLElement
  private readonly tightnessSlider: HTMLInputElement
  private readonly tightnessValue: HTMLElement
  private readonly replayButton: HTMLButtonElement
  private readonly forceBars: HTMLElement
  private readonly dragHint: HTMLElement

  private readonly decisionPanel: HTMLElement
  private readonly decisionPill: HTMLElement
  private readonly decisionTitle: HTMLElement
  private readonly decisionDetail: HTMLElement
  private readonly checksPassed: HTMLElement
  private readonly queuePeak: HTMLElement
  private readonly retainedValue: HTMLElement
  private readonly readinessNote: HTMLElement
  private readonly stageCaption: HTMLElement

  private readonly impactCorrection: HTMLElement
  private readonly impactRisk: HTMLElement
  private readonly impactBlocker: HTMLElement

  private readonly storyProgressFill: HTMLElement
  private readonly storySteps: HTMLElement[]
  private readonly storyTitle: HTMLElement
  private readonly storyCause: HTMLElement
  private readonly storyEffect: HTMLElement
  private readonly valueTitle: HTMLElement
  private readonly valueMetric: HTMLElement
  private readonly valueNote: HTMLElement

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

    this.sidebar = this.getElement('sidebar')
    this.guideStep = this.getElement('guide-step')
    this.guideTitle = this.getElement('guide-title')
    this.guideResult = this.getElement('guide-result')
    this.presetNote = this.getElement('preset-note')
    this.tightnessSlider = this.getElement<HTMLInputElement>('tightness-slider')
    this.tightnessValue = this.getElement('tightness-value')
    this.replayButton = this.getElement<HTMLButtonElement>('replay-button')
    this.forceBars = this.getElement('force-bars')
    this.dragHint = this.getElement('drag-hint')

    this.decisionPanel = this.getElement('decision-panel')
    this.decisionPill = this.getElement('decision-pill')
    this.decisionTitle = this.getElement('decision-title')
    this.decisionDetail = this.getElement('decision-detail')
    this.checksPassed = this.getElement('checks-passed')
    this.queuePeak = this.getElement('queue-peak')
    this.retainedValue = this.getElement('retained-value')
    this.readinessNote = this.getElement('readiness-note')
    this.stageCaption = this.getElement('stage-caption')

    this.impactCorrection = this.getElement('impact-correction')
    this.impactRisk = this.getElement('impact-risk')
    this.impactBlocker = this.getElement('impact-blocker')

    this.storyProgressFill = this.getElement('story-progress-fill')
    this.storySteps = Array.from(document.querySelectorAll<HTMLElement>('.story-step'))
    this.storyTitle = this.getElement('story-title')
    this.storyCause = this.getElement('story-cause')
    this.storyEffect = this.getElement('story-effect')
    this.valueTitle = this.getElement('value-title')
    this.valueMetric = this.getElement('value-metric')
    this.valueNote = this.getElement('value-note')

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
    this.syncTightness()
    this.syncModeButtons()
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

  setMode(mode: SceneMode): void {
    this.selectedMode = mode
    this.syncModeButtons()
  }

  setPresetNote(note: string): void {
    this.presetNote.textContent = note
  }

  setDragActive(active: boolean): void {
    this.dragHint.classList.toggle('active', active)
    this.dragHint.textContent = active
      ? 'Dragging proposal: ship/hold is updating live.'
      : 'Drag the red endpoint. Blue updates instantly to the safe direction.'
  }

  renderOutcome(frame: OutcomeFrameUi): void {
    this.decisionPanel.classList.toggle('ship', frame.decisionTone === 'ship')
    this.decisionPanel.classList.toggle('hold', frame.decisionTone === 'hold')

    this.decisionPill.classList.toggle('ship', frame.decisionTone === 'ship')
    this.decisionPill.classList.toggle('hold', frame.decisionTone === 'hold')
    this.decisionPill.textContent = frame.decisionTone === 'ship' ? 'SHIP' : 'HOLD'

    this.decisionTitle.textContent = frame.decisionTitle
    this.decisionDetail.textContent = frame.decisionDetail
    this.checksPassed.textContent = frame.checksText
    this.queuePeak.textContent = frame.queueText
    this.retainedValue.textContent = frame.retainedText
    this.readinessNote.textContent = frame.readinessText
    this.stageCaption.textContent = frame.stageCaption
    this.guideStep.textContent = frame.guideStep
    this.guideTitle.textContent = frame.guideTitle
    this.guideResult.textContent = frame.guideResult

    this.storyProgressFill.style.width = `${Math.round(Math.min(Math.max(frame.storyProgress, 0), 1) * 100)}%`
    this.storyTitle.textContent = frame.storyTitle
    this.storyCause.textContent = frame.storyCause
    this.storyEffect.textContent = frame.storyEffect
    this.valueTitle.textContent = frame.valueTitle
    this.valueMetric.textContent = frame.valueMetric
    this.valueNote.textContent = frame.valueNote
    this.sidebar.dataset.storyStep = `${Math.max(0, Math.min(3, frame.storyStep))}`

    for (const stepNode of this.storySteps) {
      const rawStep = Number.parseInt(stepNode.dataset.step ?? '', 10)
      const step = Number.isFinite(rawStep) ? rawStep : -1
      stepNode.classList.toggle('active', step === frame.storyStep)
      stepNode.classList.toggle('completed', step < frame.storyStep)
    }

    this.impactCorrection.textContent = frame.impactCorrectionText
    this.impactRisk.textContent = frame.impactRiskText
    this.impactBlocker.textContent = frame.impactBlockerText
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
      empty.className = 'drag-hint'
      empty.textContent = 'No active policy pressure for this patch.'
      this.forceBars.replaceChildren(empty)
      return
    }

    const maxLambda = Math.max(...items.map((item) => item.lambda), 1e-6)

    const nodes = items.map((item) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `force-bar${item.isVisible ? '' : ' hidden'}`
      button.dataset.constraintId = item.id
      button.style.boxShadow = `inset 3px 0 0 ${item.color}`

      const labelWrap = document.createElement('span')
      labelWrap.className = 'force-label'

      const name = document.createElement('span')
      name.className = 'force-name'
      name.textContent = item.label

      const meta = document.createElement('span')
      meta.className = 'force-meta'
      meta.textContent = item.isVisible ? 'Visible in canvas' : 'Click to inspect'

      const meter = document.createElement('span')
      meter.className = 'force-meter'

      const meterFill = document.createElement('span')
      meterFill.className = 'force-meter-fill'
      meterFill.style.background = item.color
      meterFill.style.width = `${Math.max(8, (item.lambda / maxLambda) * 100).toFixed(1)}%`
      meter.append(meterFill)

      labelWrap.append(name, meta, meter)

      const value = document.createElement('span')
      value.className = 'force-value'
      value.textContent = `Pressure ${item.lambda.toFixed(3)}`

      button.append(labelWrap, value)
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
      empty.textContent = 'No active policy terms. The proposal is already ship-safe.'
      this.equationTerms.replaceChildren(empty)
      return
    }

    const nodes = terms.map((term) => {
      const card = document.createElement('article')
      card.className = `math-term${term.active ? '' : ' inactive'}`
      card.style.borderLeftColor = term.color

      const head = document.createElement('div')
      head.className = 'math-term-head'

      const label = document.createElement('p')
      label.className = 'math-term-label'
      label.textContent = term.label

      const lambda = document.createElement('p')
      lambda.className = 'math-term-lambda'
      this.renderTex(lambda, term.lambdaTex, false)

      head.append(label, lambda)

      const vector = document.createElement('p')
      vector.className = 'math-term-vector'
      this.renderTex(vector, term.vectorTex, false)

      card.append(head, vector)
      return card
    })

    this.equationTerms.replaceChildren(...nodes)
  }

  private renderList(target: HTMLUListElement, items: string[], fallback: string): void {
    const rows = items.length > 0 ? items.slice(0, 4) : [fallback]
    const nodes = rows.map((row) => {
      const li = document.createElement('li')
      li.textContent = row
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

  private getElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id)
    if (!element) {
      throw new Error(`Missing UI element #${id}`)
    }
    return element as T
  }
}
