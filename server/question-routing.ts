export const questionPurposes=['usage','business_rule','business_conflict','scope','design_feedback','design_choice'] as const;
export const questionRoutingRules=`按问题性质选择唯一的正式追问对象，不按“最后谁说话”或“凡事找产品”分配：
usage：真实使用场景、为什么需要、哪里不好用，先问提出诉求的业务人员。
business_rule：必填性、允许范围、数据含义、异常处理等业务规则，问负责该场景的业务人员；业务规则出现分歧用business_conflict，找业务负责人陈敏（business）统一口径。
scope：新增能力是否安排本期、优先级、成本或范围取舍，问产品经理林舟（pm）。产品同意本期安排不等于业务规则已确认，也不等于所有成员同意。
design_feedback：设计方案是否解决使用问题，问相关业务人员，优先原诉求人；design_choice：有足够使用依据后需要确定交互/视觉方案，找产品经理组织取舍，不替业务声明共识。
按钮颜色、尺寸、布局、提示位置等属于设计要求，可写入质量要求，必要时补充验收条件；九字段是组织结构，不是需求内容白名单。不得声称界面样式不在九字段范围内。普通设计微调先给具体建议与简短理由，不一律询问是否纳入本期。只有确实涉及新增能力、成本或范围变化才用scope。
例如希望蓝色提交按钮改红色：先建议提高对比度、尺寸或位置，红色方案也可比较；不要把偏好说成统一规范或替用户选定颜色。使用目的已说明是“更醒目”时，不再泛问为什么，必要时问原诉求人哪种改法能解决问题。林舟已表达“红的不好，大家意见如何”时，优先向原诉求业务方收集设计反馈，不能再次要求林舟决定是否纳入，也不能宣布已否决或已达成一致。
确实缺少某人的回答且影响下一步时，必须设置replyRequest={participantId,purpose}并生成question，question.participantId与其一致；选项是可讨论方案，不代表已采纳。不能仅在reply、总结或评估正文中写“请林舟决定/需陈敏明确”而不生成正式追问。无需回答则replyRequest=null、question=null，直接回复或安静。已有人作答不重复催答，已有等待问题时通常继续等待。只有最新人类发言明确转向不同的业务诉求，且不是回复原问题、不是闲聊或催答时，才可设置deferQuestion={questionId:旧等待问题ID,sourceMessageId:最新人类消息ID,reason:具体转题原因}，同时给出新question及replyRequest；原问题仅暂缓、仍未回答，不得标记已解决。无需转题时deferQuestion=null。
原答复人明确撤回或更正自己的已登记决定时，设置reopenQuestion={questionId,messageId,quote}引用最新撤回原文。系统保留旧答复历史并重新开启原问题，不能只在reply说已撤回却不更新问题状态。尚无新决定时answer=null、question=null；若同一句明确给出新决定，可同时answer指向原问题和这条新消息。其他人的反对不等于撤回原答复，保留双方意见，业务口径分歧正式问陈敏；产品范围取舍问林舟，设计偏好分歧先收集使用反馈。已有正文不自动回滚、已有确认不代表新版争议已解决。
可以同时返回reply和question：reply先给建议和原因，question只问一个关键问题。收集方案意见不等于整卡确认，不要求所有成员逐一表态。`;
