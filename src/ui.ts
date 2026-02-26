import katex from 'katex'

const sliderMax = 100
const copyResetDelayMs = 1400

export interface ControlValues {
  pressure: number
  urgency: number
  strictness: number
}

export interface ProofFrameUi {
  decisionTone: 'ship' | 'hold'
  decisionTitle: string
  decisionDetail: string
  readinessScoreText: string
  readinessNote: string
  checksPassedText: string
  queuePeakText: string
  retainedValueText: string
  stageCaptionText: string
  recommendedControlsText: string
  whyItems: string[]
  gateItems: string[]
  actionItems: string[]
  memoText: string
}

export class UIController {
  private readonly scenarioButtons: HTMLButtonElement[]
  private readonly scenarioNote: HTMLElement | null
  private readonly urgencyNote: HTMLElement | null
  private readonly strictnessNote: HTMLElement | null

  private readonly urgencySlider: HTMLInputElement
  private readonly strictnessSlider: HTMLInputElement
  private readonly urgencyValue: HTMLElement
  private readonly strictnessValue: HTMLElement

  private readonly runButton: HTMLButtonElement
  private readonly autoTuneButton: HTMLButtonElement
  private readonly resetButton: HTMLButtonElement
  private readonly replayButton: HTMLButtonElement
  private readonly copyMemoButton: HTMLButtonElement

  private readonly decisionPanel: HTMLElement
  private readonly decisionPill: HTMLElement
  private readonly decisionTitle: HTMLElement
  private readonly decisionDetail: HTMLElement
  private readonly readinessScore: HTMLElement
  private readonly readinessNote: HTMLElement

  private readonly checksPassed: HTMLElement
  private readonly queuePeak: HTMLElement
  private readonly retainedValue: HTMLElement
  private readonly stageCaption: HTMLElement

  private readonly recommendedControls: HTMLElement
  private readonly whyList: HTMLUListElement
  private readonly gateList: HTMLUListElement
  private readonly actionList: HTMLUListElement
  private readonly memoText: HTMLElement

  private selectedPressure = 0.56
  private selectedUrgency = 0.58
  private selectedStrictness = 0.62
  private lastDecisionTone: 'ship' | 'hold' | null = null

  constructor() {
    this.scenarioButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.scenario-btn'))
    if (this.scenarioButtons.length === 0) {
      throw new Error('Missing .scenario-btn controls')
    }

    this.scenarioNote = document.getElementById('scenario-note')
    this.urgencyNote = document.getElementById('urgency-note')
    this.strictnessNote = document.getElementById('strictness-note')

    this.urgencySlider = this.getElement<HTMLInputElement>('urgency-slider')
    this.strictnessSlider = this.getElement<HTMLInputElement>('strictness-slider')
    this.urgencyValue = this.getElement('urgency-value')
    this.strictnessValue = this.getElement('strictness-value')

    this.runButton = this.getElement<HTMLButtonElement>('run-button')
    this.autoTuneButton = this.getElement<HTMLButtonElement>('autotune-button')
    this.resetButton = this.getElement<HTMLButtonElement>('reset-button')
    this.replayButton = this.getElement<HTMLButtonElement>('replay-button')
    this.copyMemoButton = this.getElement<HTMLButtonElement>('copy-memo-button')

    this.decisionPanel = this.getElement('decision-panel')
    this.decisionPill = this.getElement('decision-pill')
    this.decisionTitle = this.getElement('decision-title')
    this.decisionDetail = this.getElement('decision-detail')
    this.readinessScore = this.getElement('readiness-score')
    this.readinessNote = this.getElement('readiness-note')

    this.checksPassed = this.getElement('checks-passed')
    this.queuePeak = this.getElement('queue-peak')
    this.retainedValue = this.getElement('retained-value')
    this.stageCaption = this.getElement('stage-caption')

    this.recommendedControls = this.getElement('recommended-controls')
    this.whyList = this.getElement<HTMLUListElement>('why-list')
    this.gateList = this.getElement<HTMLUListElement>('gate-list')
    this.actionList = this.getElement<HTMLUListElement>('action-list')
    this.memoText = this.getElement('memo-text')

    const activeButton =
      this.scenarioButtons.find((button) => button.classList.contains('active')) ?? this.scenarioButtons[0]

    this.selectedPressure = Number.parseFloat(activeButton.dataset.pressure ?? '0.56')
    this.selectedUrgency = this.parseSliderValue(this.urgencySlider.value, 0.58)
    this.selectedStrictness = this.parseSliderValue(this.strictnessSlider.value, 0.62)

    this.renderMathBlocks()
    this.syncScenarioButtonState()
    this.syncSliderValues()
    this.setRunPending(false)
  }

  onControlsChange(callback: () => void): void {
    for (const button of this.scenarioButtons) {
      button.addEventListener('click', () => {
        const pressure = Number.parseFloat(button.dataset.pressure ?? '0.56')
        if (!Number.isFinite(pressure)) {
          return
        }

        this.selectedPressure = pressure
        this.syncScenarioButtonState()
        callback()
      })
    }

    const onSliderInput = () => {
      this.selectedUrgency = this.parseSliderValue(this.urgencySlider.value, this.selectedUrgency)
      this.selectedStrictness = this.parseSliderValue(this.strictnessSlider.value, this.selectedStrictness)
      this.syncSliderValues()
      callback()
    }

    this.urgencySlider.addEventListener('input', onSliderInput)
    this.strictnessSlider.addEventListener('input', onSliderInput)
  }

  onRunCheck(callback: () => void): void {
    this.runButton.addEventListener('click', callback)
  }

  onAutoTune(callback: () => void): void {
    this.autoTuneButton.addEventListener('click', callback)
  }

  onReset(callback: () => void): void {
    this.resetButton.addEventListener('click', callback)
  }

  onReplay(callback: () => void): void {
    this.replayButton.addEventListener('click', callback)
  }

  onCopyMemo(callback: (memoText: string) => Promise<boolean> | boolean): void {
    this.copyMemoButton.addEventListener('click', async () => {
      const memo = this.memoText.textContent ?? ''
      const copied = await callback(memo)
      this.copyMemoButton.textContent = copied ? 'Copied' : 'Copy failed'
      window.setTimeout(() => {
        this.copyMemoButton.textContent = 'Copy memo'
      }, copyResetDelayMs)
    })
  }

  onExport(callback: () => void): void {
    const exportButton = this.getElement<HTMLButtonElement>('export-button')
    exportButton.addEventListener('click', callback)
  }

  readControlValues(): ControlValues {
    return {
      pressure: this.selectedPressure,
      urgency: this.selectedUrgency,
      strictness: this.selectedStrictness,
    }
  }

  setControlValues(values: Partial<ControlValues>): void {
    if (typeof values.pressure === 'number' && Number.isFinite(values.pressure)) {
      this.selectedPressure = values.pressure
      this.syncScenarioButtonState()
    }

    if (typeof values.urgency === 'number' && Number.isFinite(values.urgency)) {
      this.selectedUrgency = values.urgency
    }

    if (typeof values.strictness === 'number' && Number.isFinite(values.strictness)) {
      this.selectedStrictness = values.strictness
    }

    this.syncSliderValues()
  }

  setRunPending(pending: boolean): void {
    this.runButton.classList.toggle('pending', pending)
    this.runButton.textContent = pending ? 'Simulate patch (pending changes)' : 'Simulate patch'
  }

  renderFrame(frame: ProofFrameUi): void {
    const toneChanged = this.lastDecisionTone !== frame.decisionTone

    this.decisionPanel.classList.toggle('ship', frame.decisionTone === 'ship')
    this.decisionPanel.classList.toggle('hold', frame.decisionTone === 'hold')

    this.decisionPill.classList.toggle('ship', frame.decisionTone === 'ship')
    this.decisionPill.classList.toggle('hold', frame.decisionTone === 'hold')
    this.decisionPill.textContent = frame.decisionTone === 'ship' ? 'SHIP' : 'HOLD'

    this.decisionTitle.textContent = frame.decisionTitle
    this.decisionDetail.textContent = frame.decisionDetail
    this.readinessScore.textContent = frame.readinessScoreText
    this.readinessNote.textContent = frame.readinessNote

    this.checksPassed.textContent = frame.checksPassedText
    this.queuePeak.textContent = frame.queuePeakText
    this.retainedValue.textContent = frame.retainedValueText
    this.stageCaption.textContent = frame.stageCaptionText
    this.recommendedControls.textContent = frame.recommendedControlsText
    this.memoText.textContent = frame.memoText

    this.renderList(this.whyList, frame.whyItems, 'Rationale unavailable.')
    this.renderList(this.gateList, frame.gateItems, 'Rollout gates unavailable.')
    this.renderList(this.actionList, frame.actionItems, 'No actions generated.')

    if (toneChanged) {
      this.flash(this.decisionPanel)
    }
    this.lastDecisionTone = frame.decisionTone
  }

  private renderList(target: HTMLUListElement, items: string[], fallback: string): void {
    const lines = items.length > 0 ? items.slice(0, 4) : [fallback]
    const nodes = lines.map((item) => {
      const line = document.createElement('li')
      line.textContent = item
      return line
    })
    target.replaceChildren(...nodes)
  }

  private renderMathBlocks(): void {
    const equationRaw = this.getElement('equation-raw')
    const equationQp = this.getElement('equation-qp')

    equationRaw.innerHTML = katex.renderToString(String.raw`\Delta_0 = -\eta\,g_{\text{new}}`, {
      displayMode: true,
      throwOnError: false,
      output: 'html',
    })

    equationQp.innerHTML = katex.renderToString(
      String.raw`\Delta^\star = \operatorname{proj}_{\mathcal{C}}(\Delta_0),\quad \mathcal{C}=\{\Delta\mid n_k^\top\Delta\le\varepsilon_k\}`,
      {
        displayMode: true,
        throwOnError: false,
        output: 'html',
      },
    )
  }

  private syncScenarioButtonState(): void {
    let closestIndex = 0
    let closestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < this.scenarioButtons.length; index += 1) {
      const pressure = Number.parseFloat(this.scenarioButtons[index].dataset.pressure ?? '0')
      const distance = Math.abs(pressure - this.selectedPressure)
      if (distance < closestDistance) {
        closestDistance = distance
        closestIndex = index
      }
    }

    this.scenarioButtons.forEach((button, index) => {
      const active = index === closestIndex
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    })

    this.selectedPressure = Number.parseFloat(this.scenarioButtons[closestIndex].dataset.pressure ?? '0.56')

    if (this.scenarioNote) {
      this.scenarioNote.textContent = this.describeScenario(this.selectedPressure)
    }
  }

  private syncSliderValues(): void {
    this.selectedUrgency = this.clamp01(this.selectedUrgency)
    this.selectedStrictness = this.clamp01(this.selectedStrictness)

    this.urgencySlider.value = Math.round(this.selectedUrgency * sliderMax).toString()
    this.strictnessSlider.value = Math.round(this.selectedStrictness * sliderMax).toString()

    this.urgencyValue.textContent = `${Math.round(this.selectedUrgency * 100)}%`
    this.strictnessValue.textContent = `${Math.round(this.selectedStrictness * 100)}%`

    if (this.urgencyNote) {
      this.urgencyNote.textContent = this.describeUrgency(this.selectedUrgency)
    }

    if (this.strictnessNote) {
      this.strictnessNote.textContent = this.describeStrictness(this.selectedStrictness)
    }
  }

  private parseSliderValue(raw: string, fallback: number): number {
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) {
      return fallback
    }
    return this.clamp01(parsed / sliderMax)
  }

  private clamp01(value: number): number {
    return Math.min(Math.max(value, 0), 1)
  }

  private describeScenario(pressure: number): string {
    if (pressure < 0.38) {
      return 'Normal traffic: lower queue pressure and lower immediate risk.'
    }
    if (pressure < 0.75) {
      return 'Spike traffic: meaningful queue pressure, still manageable with correct projection.'
    }
    return 'Incident traffic: severe pressure where unsafe raw patches escalate quickly.'
  }

  private describeUrgency(urgency: number): string {
    if (urgency < 0.34) {
      return 'Low urgency: projection can prioritize safety conservatively.'
    }
    if (urgency < 0.67) {
      return 'Balanced urgency: keep value while correcting unsafe components.'
    }
    return 'Critical urgency: projection must keep as much useful gain as possible.'
  }

  private describeStrictness(strictness: number): string {
    if (strictness < 0.34) {
      return 'Relaxed checks: easier to retain gain, lower safety margin.'
    }
    if (strictness < 0.67) {
      return 'Moderate checks: typical production guardrail envelope.'
    }
    return 'Tight checks: conservative release posture with stricter boundaries.'
  }

  private flash(element: HTMLElement): void {
    element.classList.remove('flash')
    void element.offsetWidth
    element.classList.add('flash')
  }

  private getElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id)
    if (!element) {
      throw new Error(`Missing UI element #${id}`)
    }
    return element as T
  }
}
