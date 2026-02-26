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

export interface OutcomeFrameUi {
  decisionTone: 'ship' | 'hold'
  decisionTitle: string
  decisionDetail: string
  checksText: string
  queueText: string
  retainedText: string
  readinessText: string
  stageCaption: string
}

export interface DetailFrameUi {
  presetNote: string
  whyItems: string[]
  actionItems: string[]
  memoText: string
}

export class UIController {
  private readonly presetButtons: HTMLButtonElement[]
  private readonly modeButtons: HTMLButtonElement[]

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

  private readonly whyList: HTMLUListElement
  private readonly actionList: HTMLUListElement
  private readonly memoText: HTMLElement
  private readonly copyMemoButton: HTMLButtonElement
  private readonly exportButton: HTMLButtonElement

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

    this.whyList = this.getElement<HTMLUListElement>('why-list')
    this.actionList = this.getElement<HTMLUListElement>('action-list')
    this.memoText = this.getElement('memo-text')
    this.copyMemoButton = this.getElement<HTMLButtonElement>('copy-memo-button')
    this.exportButton = this.getElement<HTMLButtonElement>('export-button')

    const activePreset = this.presetButtons.find((button) => button.classList.contains('active')) ?? this.presetButtons[0]
    this.selectedPresetId = this.parsePresetId(activePreset.dataset.preset)
    this.selectedPressure = this.parsePressure(activePreset.dataset.pressure, 0.56)

    const activeMode = this.modeButtons.find((button) => button.classList.contains('active')) ?? this.modeButtons[0]
    this.selectedMode = this.parseMode(activeMode.dataset.mode)

    this.selectedTightness = this.clamp01(this.parseSliderValue(this.tightnessSlider.value, 0.62))

    this.syncPresetButtons()
    this.syncTightness()
    this.syncModeButtons()
    this.renderMath()
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
      ? 'Dragging Δ0: watch Δ* and active checks respond.'
      : 'Drag directly on the canvas or grab the Δ0 tip.'
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
  }

  renderDetails(frame: DetailFrameUi): void {
    this.presetNote.textContent = frame.presetNote
    this.memoText.textContent = frame.memoText
    this.renderList(this.whyList, frame.whyItems, 'No rationale yet.')
    this.renderList(this.actionList, frame.actionItems, 'No action generated yet.')
  }

  renderForceBars(items: ForceBarUi[]): void {
    if (items.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'drag-hint'
      empty.textContent = 'No active correction forces for this patch.'
      this.forceBars.replaceChildren(empty)
      return
    }

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
      meta.textContent = item.isVisible ? 'Visible in stage' : 'Hidden in stage'

      labelWrap.append(name, meta)

      const value = document.createElement('span')
      value.className = 'force-value'
      value.textContent = `λ ${item.lambda.toFixed(3)}`

      button.append(labelWrap, value)
      return button
    })

    this.forceBars.replaceChildren(...nodes)
  }

  toggleForcePanel(show: boolean): void {
    this.forceBars.classList.toggle('hidden', !show)
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

  private renderMath(): void {
    const equationNode = this.getElement('equation-main')
    equationNode.innerHTML = katex.renderToString(
      String.raw`\Delta^\star = \Delta_0 + \sum_{k\in\mathcal{A}}\left(-\eta\,\lambda_k\,n_k\right),\quad n_k^\top\Delta^\star\le\varepsilon_k`,
      {
        displayMode: true,
        throwOnError: false,
        output: 'html',
      },
    )
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
