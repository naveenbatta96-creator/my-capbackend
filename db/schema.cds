namespace lockbox.templatebuilder;

using {
    cuid,
    managed
} from '@sap/cds/common';

entity TemplateMaster : cuid, managed {
    templateName          : String(100);
    templateType          : String(50);
    sheetMode             : String(20);
    status                : String(20);
    isStandard            : Boolean default false; // ✅ NEW
    virtual mappingsCount : Integer; // For storing the count of associated fields
    mappings              : Composition of many TemplateFieldMapping
                                on mappings.template = $self;
}


entity FieldMaster : cuid {
    levelName    : String(30);
    fieldName    : String(100);
    sapType      : String(40);
    fieldLength  : String(20);
    propertyType : String(20);
    isStandard   : Boolean default true;
    isRequired   : Boolean;
    isCustom     : Boolean default false; // ✅ NEW — tracks user-added fields
}

entity TemplateFieldMapping : cuid {
    template        : Association to TemplateMaster;
    field           : Association to FieldMaster;
    sourceFieldName : String(100);
    sequenceNo      : Integer;
    targetField     : String(100);
    apiField        : String(100);
    mappingRule     : String(100);
    ruleId          : String(50);
    ruleName        : String(100);
}

//================================================================
// View for Field Count in a saved template
//================================================================
view TemplateMasterWithCount as
    select from TemplateMaster {
        *,
        (
            select count( * ) from TemplateFieldMapping
            where
                TemplateFieldMapping.template.ID = TemplateMaster.ID
        ) as mappingsCount : Integer
    };
