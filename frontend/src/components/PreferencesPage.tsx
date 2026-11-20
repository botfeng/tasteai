import { useEffect, useRef, useState } from 'react'
import { ingredientOptions, tasteOptions } from '../data/preferences'
import type { Preferences } from '../data/preferences'
import { recipes } from '../data/recipes'
import FoodImage from './FoodImage'
import Icon from './Icon'

const stepNames = ['喜欢的味道', '偏爱的食材', '下厨的时间']

export default function PreferencesPage({ preferences, onComplete }: {
  preferences: Preferences
  onComplete: (preferences: Preferences) => void
}) {
  const [draft, setDraft] = useState<Preferences>(() => ({ ...preferences }))
  const [step, setStep] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [step])

  function toggle(field: 'tastes' | 'ingredients', value: string) {
    setDraft((previous) => ({ ...previous, [field]: previous[field].includes(value) ? previous[field].filter((item) => item !== value) : [...previous[field], value] }))
  }

  return (
    <main className="onboarding-page page-enter">
      <div className="onboarding-toolbar">
        {step === 0 ? <a className="icon-button" href="#home" aria-label="返回首页"><Icon name="back" /></a> : <button type="button" className="icon-button" aria-label="上一步" onClick={() => setStep(step - 1)}><Icon name="back" /></button>}
        <span>认识你的口味</span>
        <a className="text-button" href="#home">跳过</a>
      </div>
      <div className="onboarding-layout">
        <aside className="onboarding-story" aria-label="从一顿喜欢的饭开始">
          <FoodImage src={recipes[0].image} alt={recipes[0].photoAlt} priority />
          <div className="story-note"><Icon name="leaf" size={18} /><span>一日三餐，<br /><strong>都值得好好喜欢。</strong></span></div>
          <span className="story-caption">给日常，加一点好味道</span>
        </aside>
        <section className="onboarding-form">
          <div className="step-label"><span>你的口味档案</span><span>0{step + 1} <span className="muted">/ 03</span></span></div>
          <ol className="step-progress" aria-label={`第 ${step + 1} 步，共 3 步`}>
            {stepNames.map((name, index) => <li key={name} className={index <= step ? 'is-complete' : ''} aria-current={index === step ? 'step' : undefined}><span className="sr-only">{name}</span></li>)}
          </ol>
          <h1 ref={heading} tabIndex={-1}>{['先聊聊，你喜欢的味道', '哪些食材，更合你心意？', '今天，想花多久下厨？'][step]}</h1>
          <p className="onboarding-subtitle">{['没有标准答案，选你喜欢的就好。', '选几样常吃的，为下一餐找点灵感。', '快手一餐，或慢慢享受，都很好。'][step]}</p>

          {step === 0 && <fieldset className="choice-fieldset"><legend>口味偏好 <span>可多选 · 不选代表不限</span></legend><div className="taste-grid">
            {tasteOptions.map((option) => <button key={option.label} type="button" className={`taste-choice ${draft.tastes.includes(option.label) ? 'is-selected' : ''}`} aria-pressed={draft.tastes.includes(option.label)} onClick={() => toggle('tastes', option.label)}><span className="choice-icon"><Icon name={option.icon} size={23} /></span><span><strong>{option.label}</strong><small>{option.description}</small></span><span className="choice-check">{draft.tastes.includes(option.label) && <Icon name="check" size={12} />}</span></button>)}
          </div></fieldset>}

          {step === 1 && <fieldset className="choice-fieldset"><legend>食材偏好 <span>可多选 · 匹配任一所选食材</span></legend><div className="ingredient-grid">
            {ingredientOptions.map((option) => <button key={option.label} type="button" className={`ingredient-choice ${draft.ingredients.includes(option.label) ? 'is-selected' : ''}`} aria-pressed={draft.ingredients.includes(option.label)} onClick={() => toggle('ingredients', option.label)}><Icon name={option.icon} size={28} /><strong>{option.label}</strong><span className="choice-check">{draft.ingredients.includes(option.label) && <Icon name="check" size={12} />}</span></button>)}
          </div><p className="field-note">这不是忌口或过敏原设置。食材过敏时，请逐项核对菜谱与包装标签。</p></fieldset>}

          {step === 2 && <fieldset className="choice-fieldset"><legend>预计用时 <span>单选</span></legend><div className="time-options">
            {[
              { value: 15, title: '15 分钟内', detail: '简单快手，不用等太久', icon: 'spark' as const },
              { value: 30, title: '30 分钟内', detail: '留一点时间，认真做顿饭', icon: 'clock' as const },
              { value: 0, title: '时间不限', detail: '不赶时间，慢慢做也很好', icon: 'bowl' as const },
            ].map((option) => <label key={option.value} className={`time-choice ${draft.maxMinutes === option.value ? 'is-selected' : ''}`}><Icon name={option.icon} size={25} /><span><strong>{option.title}</strong><small>{option.detail}</small></span><input type="radio" name="cooking-time" value={option.value} checked={draft.maxMinutes === option.value} onChange={() => setDraft({ ...draft, maxMinutes: option.value })} /></label>)}
          </div><p className="field-note">预计时间包含备菜与烹饪，实际用时因熟练程度而异。</p></fieldset>}

          <div className="onboarding-actions">
            <button type="button" className="primary-button" onClick={() => step < 2 ? setStep(step + 1) : onComplete({ ...draft, configured: true })}>{step === 2 ? '看看我的推荐' : '下一步'}<Icon name="arrow" size={18} /></button>
            <p>只保存在此浏览器，随时可以调整</p>
          </div>
        </section>
      </div>
    </main>
  )
}
